import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { apiUrl, mintApiToken } from "@/lib/api";
import { WORKSPACE_COOKIE, getContext } from "@/lib/context";

/**
 * Same-origin proxy so client components (canvas autosave, test console streaming) can call the API
 * as the signed-in user. Adds the short-lived API token and the selected workspace; streams responses through.
 */
async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(req.url).origin && origin !== process.env.AUTH_URL) {
      return Response.json({ error: "Cross-site request refused" }, { status: 403 });
    }
  }
  const token = await mintApiToken();
  if (!token) return Response.json({ error: "Not signed in" }, { status: 401 });

  const { path } = await params;
  const target = new URL(`${apiUrl()}/v1/${path.map(encodeURIComponent).join("/")}`);
  target.search = new URL(req.url).search;
  // Same rule as server pages: the selected workspace cookie, else the user's first workspace.
  const workspaceId = (await cookies()).get(WORKSPACE_COOKIE)?.value ?? (await getContext()).current?.id ?? "";

  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-workspace-id": workspaceId,
      ...(req.headers.get("content-type") ? { "content-type": req.headers.get("content-type")! } : {}),
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
    cache: "no-store",
  });

  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "content-disposition"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const dynamic = "force-dynamic";
