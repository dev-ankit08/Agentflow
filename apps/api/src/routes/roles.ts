import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { customRoles, memberships } from "@agentflow/db";
import { HttpError, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { PERMISSIONS, permissionIds, presetPermissions, type Permission } from "../permissions";

const RoleBody = z.object({
  name: z.string().trim().min(1).max(60),
  /** Built-in role used for everything not covered by a permission. Owners stay a built-in role. */
  baseRole: z.enum(["viewer", "reviewer", "builder", "admin"]),
  permissions: z.array(z.enum(permissionIds as [Permission, ...Permission[]])).max(permissionIds.length),
});

/** Custom roles (H6): named permission sets on top of a built-in base role. */
export async function roleRoutes(app: FastifyInstance, { db, auth }: Deps) {
  const find = async (workspaceId: string, id: string) => {
    const [row] = await db
      .select()
      .from(customRoles)
      .where(and(eq(customRoles.id, id), eq(customRoles.workspaceId, workspaceId)));
    if (!row) throw new HttpError(404, "Role not found");
    return row;
  };

  app.get("/roles", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const ws = currentWorkspace(req);
    const rows = await db
      .select({
        id: customRoles.id,
        name: customRoles.name,
        baseRole: customRoles.baseRole,
        permissions: customRoles.permissions,
        members: sql<number>`(select count(*)::int from ${memberships} where ${memberships.customRoleId} = ${customRoles.id})`,
      })
      .from(customRoles)
      .where(eq(customRoles.workspaceId, ws.id))
      .orderBy(asc(customRoles.name));
    return {
      roles: rows,
      permissions: permissionIds.map((id) => ({ id, label: PERMISSIONS[id].label, preset: PERMISSIONS[id].preset })),
      presets: Object.fromEntries(
        (["viewer", "reviewer", "builder", "admin", "owner"] as const).map((r) => [r, presetPermissions(r)]),
      ),
    };
  });

  app.post("/roles", { preHandler: auth.requireWorkspace("admin") }, async (req, reply) => {
    const body = RoleBody.parse(req.body);
    const ws = currentWorkspace(req);
    const [row] = await db
      .insert(customRoles)
      .values({ ...body, workspaceId: ws.id })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HttpError(409, `A role named "${body.name}" already exists`);
    return reply.code(201).send(row);
  });

  app.put<{ Params: { id: string } }>("/roles/:id", { preHandler: auth.requireWorkspace("admin") }, async (req) => {
    const body = RoleBody.parse(req.body);
    const ws = currentWorkspace(req);
    await find(ws.id, req.params.id);
    const [row] = await db
      .update(customRoles)
      .set(body)
      .where(and(eq(customRoles.id, req.params.id), eq(customRoles.workspaceId, ws.id)))
      .returning();
    // Members keep the role's base role in step, so built-in checks match what admins see.
    await db
      .update(memberships)
      .set({ role: body.baseRole })
      .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.customRoleId, req.params.id)));
    return row;
  });

  /** Members with the role keep its base role as their built-in role. */
  app.delete<{ Params: { id: string } }>(
    "/roles/:id",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await find(ws.id, req.params.id);
      await db.delete(customRoles).where(and(eq(customRoles.id, req.params.id), eq(customRoles.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );
}
