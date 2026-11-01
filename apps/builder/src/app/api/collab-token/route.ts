import { mintCollabToken } from "@/lib/api";

/** Gives the editor a token and address for the live co-editing socket on the API. */
export async function GET() {
  const token = await mintCollabToken();
  if (!token) return Response.json({ error: "Not signed in" }, { status: 401 });
  const api = process.env.PUBLIC_API_URL ?? process.env.API_URL ?? "http://localhost:4000";
  return Response.json(
    { token, url: `${api.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/collab` },
    { headers: { "cache-control": "no-store" } },
  );
}

export const dynamic = "force-dynamic";
