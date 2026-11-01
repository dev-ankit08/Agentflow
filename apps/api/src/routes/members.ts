import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { customRoles, invites, memberships, roles, users, type Db, type Role } from "@agentflow/db";
import { HttpError, currentUser, currentWorkspace, hasRole } from "../auth";
import type { Deps } from "../app";
import { roleRank, type Permission } from "../permissions";

/** Members can't hand out a role above their own, nor a custom role with permissions they lack. */
function assertCanAssign(
  ws: { role: Role; permissions: Permission[] },
  role: Role,
  customPermissions: string[] | null = null,
) {
  if (ws.role === "owner") return;
  if (roleRank(role) > roleRank(ws.role)) throw new HttpError(403, `You can't assign a role above your own (${role})`);
  const missing = (customPermissions ?? []).filter((p) => !ws.permissions.includes(p as Permission));
  if (missing.length) throw new HttpError(403, `That role has permissions you don't have: ${missing.join(", ")}`);
}

const Invite = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(roles),
});
/** Either a built-in role (clears any custom role) or a custom role (its base role becomes the built-in role). */
const ChangeRole = z.union([
  z.object({ role: z.enum(roles) }),
  z.object({ customRoleId: z.string().min(1).nullable() }),
]);

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
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        customRoleId: memberships.customRoleId,
        customRole: customRoles.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(customRoles, eq(customRoles.id, memberships.customRoleId))
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
    assertCanAssign(ws, body.role);

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
      const body = ChangeRole.parse(req.body);
      const ws = currentWorkspace(req);
      let role: Role;
      let customRoleId: string | null = null;
      if ("role" in body) role = body.role;
      else if (body.customRoleId === null) {
        const [current] = await db
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, req.params.userId)));
        if (!current) throw new HttpError(404, "Member not found");
        role = current.role;
      } else {
        const [custom] = await db
          .select()
          .from(customRoles)
          .where(and(eq(customRoles.id, body.customRoleId), eq(customRoles.workspaceId, ws.id)));
        if (!custom) throw new HttpError(404, "Role not found");
        role = custom.baseRole;
        customRoleId = custom.id;
        assertCanAssign(ws, role, custom.permissions);
      }
      if ("role" in body) assertCanAssign(ws, role);
      const [target] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, req.params.userId)));
      if (!target) throw new HttpError(404, "Member not found");
      if (ws.role !== "owner" && roleRank(target.role) > roleRank(ws.role)) {
        throw new HttpError(403, "You can't change the role of someone above you");
      }
      if ((role === "owner" || target.role === "owner") && !hasRole(ws.role, "owner")) {
        throw new HttpError(403, "Only owners can change owner roles");
      }
      if (target.role === "owner" && role !== "owner" && (await ownerCount(db, ws.id)) <= 1) {
        throw new HttpError(409, "A workspace needs at least one owner");
      }
      await db
        .update(memberships)
        .set({ role, customRoleId })
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, req.params.userId)));
      return { userId: req.params.userId, role, customRoleId };
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
      if (ws.role !== "owner" && roleRank(target.role) > roleRank(ws.role)) {
        throw new HttpError(403, "You can't remove someone above you");
      }
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
