import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invites, memberships, orgs, workspaces } from "@agentflow/db";
import { currentUser } from "../auth";
import type { Deps } from "../app";
import { provisionTrialDemo } from "../trial";

const CreateOrg = z.object({
  orgName: z.string().trim().min(1).max(100),
  workspaceName: z.string().trim().min(1).max(100).default("Default"),
});

export async function accountRoutes(app: FastifyInstance, { db, auth, secrets, config }: Deps) {
  app.addHook("preHandler", auth.authenticate);

  /** Current user and their workspaces. Pending invites for the user's email are accepted here. */
  app.get("/me", async (req) => {
    const user = currentUser(req);
    if (user.email) {
      const email = user.email.toLowerCase();
      await db.transaction(async (tx) => {
        const pending = await tx
          .select()
          .from(invites)
          .where(and(eq(invites.email, email), isNull(invites.acceptedAt)));
        for (const invite of pending) {
          await tx
            .insert(memberships)
            .values({ userId: user.id, workspaceId: invite.workspaceId, role: invite.role })
            .onConflictDoNothing();
          await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
        }
      });
    }
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        orgId: orgs.id,
        orgName: orgs.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .innerJoin(orgs, eq(orgs.id, workspaces.orgId))
      .where(eq(memberships.userId, user.id))
      .orderBy(orgs.name, workspaces.name);
    return { user, workspaces: rows };
  });

  /** Creates an org with a first workspace; the caller becomes its owner. */
  app.post("/orgs", async (req, reply) => {
    const body = CreateOrg.parse(req.body);
    const user = currentUser(req);
    const workspace = await db.transaction(async (tx) => {
      const [org] = await tx.insert(orgs).values({ name: body.orgName }).returning();
      const [ws] = await tx.insert(workspaces).values({ orgId: org!.id, name: body.workspaceName }).returning();
      await tx.insert(memberships).values({ userId: user.id, workspaceId: ws!.id, role: "owner" });
      return { id: ws!.id, name: ws!.name, orgId: org!.id, orgName: org!.name, role: "owner" as const };
    });
    if (config.trialDemo.modelUrl || config.trialDemo.mcpUrl) {
      await provisionTrialDemo(db, secrets, config.trialDemo, workspace.id).catch((err) =>
        req.log.error({ err }, "trial demo provisioning failed"),
      );
    }
    return reply.code(201).send(workspace);
  });
}
