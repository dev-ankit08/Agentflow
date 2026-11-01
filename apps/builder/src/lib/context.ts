import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Role } from "@agentflow/db";
import { apiFetch } from "./api";

export const WORKSPACE_COOKIE = "af_ws";

export type WorkspaceSummary = { id: string; name: string; orgId: string; orgName: string; role: Role };
export type Me = { user: { id: string; email: string | null; name: string | null }; workspaces: WorkspaceSummary[] };

const rank: Record<Role, number> = { viewer: 1, reviewer: 2, builder: 3, admin: 4, owner: 5 };
export const can = (ws: WorkspaceSummary, min: Role) => rank[ws.role] >= rank[min];

/** The signed-in user, their workspaces and the selected one (cookie, falling back to the first). */
export const getContext = cache(async () => {
  const me = await apiFetch<Me>("/v1/me");
  const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = me.workspaces.find((w) => w.id === selected) ?? me.workspaces[0] ?? null;
  return { ...me, current };
});

/** For pages inside the app shell, where a workspace is guaranteed by the layout. */
export async function requireWorkspace() {
  const ctx = await getContext();
  if (!ctx.current) throw new Error("No workspace selected");
  return { ...ctx, current: ctx.current };
}
