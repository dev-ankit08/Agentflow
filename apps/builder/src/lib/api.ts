import "server-only";
import { SignJWT } from "jose";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const apiUrl = () => process.env.API_URL ?? "http://localhost:4000";

/**
 * Short-lived JWT for the signed-in user (verified by apps/api/src/auth.ts), so the API never
 * needs the Auth.js session cookie. Returns null when nobody is signed in.
 */
export async function mintApiToken(): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return new SignJWT({ email: session.user.email ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.user.id)
    .setIssuer("agentflow-builder")
    .setAudience("agentflow-api")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(process.env.API_JWT_SECRET ?? ""));
}

/** Calls the AgentFlow API as the signed-in user (server components and actions). */
export async function apiFetch<T>(
  path: string,
  { method = "GET", body, workspaceId }: { method?: string; body?: unknown; workspaceId?: string } = {},
): Promise<T> {
  const token = await mintApiToken();
  if (!token) redirect("/login");

  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = data.issues?.[0];
    throw new ApiError(
      res.status,
      issue ? `${issue.path ? `${issue.path}: ` : ""}${issue.message}` : (data.error ?? res.statusText),
    );
  }
  return data as T;
}

/** A one-hour token for the live co-editing socket (audience "agentflow-collab"). */
export async function mintCollabToken(): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.user.id)
    .setIssuer("agentflow-builder")
    .setAudience("agentflow-collab")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.API_JWT_SECRET ?? ""));
}
