import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { customRoles, memberships, users, workspaces, type Db, type Role } from "@agentflow/db";
import { ROUTE_PERMISSIONS, presetPermissions, type Permission } from "./permissions";

/** Builder → API tokens: short-lived HS256 JWTs minted server-side by the builder (see apps/builder/src/lib/api.ts). */
export const TOKEN_ISSUER = "agentflow-builder";
export const TOKEN_AUDIENCE = "agentflow-api";

export type AuthUser = { id: string; email: string | null; name: string | null };
export type WorkspaceContext = {
  id: string;
  orgId: string;
  role: Role;
  /** Set when the member has a custom role; its permissions then decide on protected routes. */
  customRoleId?: string | null;
  permissions: Permission[];
};

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    workspace?: WorkspaceContext;
  }
}

const rank: Record<Role, number> = { viewer: 1, reviewer: 2, builder: 3, admin: 4, owner: 5 };
export const hasRole = (role: Role, min: Role) => rank[role] >= rank[min];

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function makeAuth(db: Db, jwtSecret: string) {
  const key = new TextEncoder().encode(jwtSecret);

  async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Missing bearer token");
    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(header.slice(7), key, { issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE });
      sub = payload.sub;
    } catch {
      throw new HttpError(401, "Invalid or expired token");
    }
    if (!sub) throw new HttpError(401, "Token has no subject");
    const [user] = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, sub));
    if (!user) throw new HttpError(401, "Unknown user");
    req.user = user;
  }

  /**
   * Requires an `x-workspace-id` header for a workspace the user belongs to, with at least `min` role.
   * Members with a custom role are checked against its permissions instead on routes listed in ROUTE_PERMISSIONS.
   */
  function requireWorkspace(min: Role) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) await authenticate(req, reply);
      const workspaceId = req.headers["x-workspace-id"];
      if (typeof workspaceId !== "string" || !workspaceId) throw new HttpError(400, "Missing x-workspace-id header");
      const [row] = await db
        .select({
          id: workspaces.id,
          orgId: workspaces.orgId,
          role: memberships.role,
          customRoleId: memberships.customRoleId,
          customPermissions: customRoles.permissions,
        })
        .from(memberships)
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .leftJoin(customRoles, eq(customRoles.id, memberships.customRoleId))
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, req.user!.id)));
      if (!row) throw new HttpError(404, "Workspace not found");
      const custom = row.customRoleId ? ((row.customPermissions ?? []) as Permission[]) : null;
      const needed = custom ? ROUTE_PERMISSIONS[`${req.method} ${req.routeOptions.url}`] : undefined;
      if (needed) {
        if (!custom!.includes(needed)) throw new HttpError(403, `Your role does not allow this (${needed})`);
      } else if (!hasRole(row.role, min)) {
        throw new HttpError(403, `Requires ${min} role or higher`);
      }
      req.workspace = {
        id: row.id,
        orgId: row.orgId,
        role: row.role,
        customRoleId: row.customRoleId,
        permissions: custom ?? presetPermissions(row.role),
      };
    };
  }

  return { authenticate, requireWorkspace };
}

export type Auth = ReturnType<typeof makeAuth>;

export const currentUser = (req: FastifyRequest) => req.user!;
export const currentWorkspace = (req: FastifyRequest) => req.workspace!;
