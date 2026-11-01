import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invites, memberships, roles, users, type Db } from "@agentflow/db";
import { HttpError, currentUser, currentWorkspace, hasRole } from "../auth";
import type { Deps } from "../app";

const Invite = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(roles),
});
const ChangeRole = z.object({ role: z.enum(roles) });

async function ownerCount(db: Db, workspaceId: string) {
  const owners = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner")));
  return owners.length;
}

export async function memberRoutes(app: FastifyInstance, { db, auth }: Deps) {
  app.get("/members", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const ws = currentWorkspace(req);
    const members = await db
      .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, ws.id))
      .orderBy(users.email);
    const pending = await db
      .select({ id: invites.id, email: invites.email, role: invites.role, createdAt: invites.createdAt })
      .from(invites)
      .where(and(eq(invites.workspaceId, ws.id), isNull(invites.acceptedAt)));
    return { members, invites: pending };
  });

  /** Invites by email. Existing users are added straight away; others join on their first sign-in. */
  app.post("/invites", { preHandler: auth.requireWorkspace("admin") }, async (req, reply) => {
    const body = Invite.parse(req.body);
    const ws = currentWorkspace(req);
    if (body.role === "owner" && ws.role !== "owner") throw new HttpError(403, "Only owners can invite owners");

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (existing) {
      await db
        .insert(memberships)
        .values({ userId: existing.id, workspaceId: ws.id, role: body.role })
        .onConflictDoNothing();
      return reply.code(201).send({ status: "added" });
    }
    await db
      .insert(invites)
      .values({ workspaceId: ws.id, email: body.email, role: body.role, invitedBy: currentUser(req).id })
      .onConflictDoUpdate({ target: [invites.workspaceId, invites.email], set: { role: body.role, acceptedAt: null } });
    return reply.code(201).send({ status: "invited" });
  });

  app.delete<{ Params: { id: string } }>(
    "/invites/:id",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await db.delete(invites).where(and(eq(invites.id, req.params.id), eq(invites.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: { userId: string } }>(
    "/members/:userId",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const { role } = ChangeRole.parse(req.body);
      const ws = currentWorkspace(req);
      const [target] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, req.params.userId)));
      if (!target) throw new HttpError(404, "Member not found");
      if ((role === "owner" || target.role === "owner") && !hasRole(ws.role, "owner")) {
        throw new HttpError(403, "Only owners can change owner roles");
      }
      if (target.role === "owner" && role !== "owner" && (await ownerCount(db, ws.id)) <= 1) {
        throw new HttpError(409, "A workspace needs at least one owner");
      }
      await db
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, req.params.userId)));
      return { userId: req.params.userId, role };
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/members/:userId",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      const [target] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, req.params.userId)));
      if (!target) throw new HttpError(404, "Member not found");
      if (target.role === "owner") {
        if (!hasRole(ws.role, "owner")) throw new HttpError(403, "Only owners can remove owners");
        if ((await ownerCount(db, ws.id)) <= 1) throw new HttpError(409, "A workspace needs at least one owner");
      }
      await db
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, req.params.userId)));
      return reply.code(204).send();
    },
  );
}
