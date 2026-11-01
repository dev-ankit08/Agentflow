import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { createDb, orgs, users } from "@agentflow/db";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "../src/app";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";
import { loadRootEnv } from "../src/config";

// Integration tests against a real Postgres (run `pnpm db:start` + `pnpm db:migrate` first). Skipped without DATABASE_URL.
loadRootEnv();
const url = process.env.DATABASE_URL;
const jwtSecret = "test-secret-at-least-16-chars";

describe.skipIf(!url)("API", () => {
  const { db, close } = createDb(url ?? "", { max: 2 });
  const run = randomBytes(4).toString("hex");
  const alice = { id: `usr_alice_${run}`, email: `alice-${run}@test.local` };
  const bob = { id: `usr_bob_${run}`, email: `bob-${run}@test.local` };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let workspaceId = "";
  let orgId = "";

  const token = (sub: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));

  const call = async (as: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: object) =>
    app.inject({
      method,
      url: path,
      headers: {
        authorization: `Bearer ${await token(as)}`,
        ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      },
      ...(body ? { payload: body } : {}),
    });

  beforeAll(async () => {
    app = await buildApp({
      db,
      secrets: createSecretStore(randomBytes(32).toString("base64")),
      jwtSecret,
      corsOrigin: "http://localhost:3000",
    });
    await db.insert(users).values([alice, bob]);
  });

  afterAll(async () => {
    // Remove everything this run created (orgs cascade to workspaces, members, keys and flows).
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(like(users.id, `%_${run}`));
    await app.close();
    await close();
  });

  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects missing and invalid tokens", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("creates an org and makes the caller owner", async () => {
    const res = await call(alice.id, "POST", "/v1/orgs", { orgName: "Acme" });
    expect(res.statusCode).toBe(201);
    workspaceId = res.json().id;
    orgId = res.json().orgId;
    const me = (await call(alice.id, "GET", "/v1/me")).json();
    expect(me.workspaces).toEqual([expect.objectContaining({ id: workspaceId, orgName: "Acme", role: "owner" })]);
  });

  it("hides workspaces from non-members", async () => {
    expect((await call(bob.id, "GET", "/v1/flows")).statusCode).toBe(404);
  });

  it("adds existing users as members and enforces roles", async () => {
    const res = await call(alice.id, "POST", "/v1/invites", { email: bob.email, role: "viewer" });
    expect(res.json()).toEqual({ status: "added" });
    expect((await call(bob.id, "GET", "/v1/flows")).statusCode).toBe(200);
    expect((await call(bob.id, "POST", "/v1/flows", { name: "Nope" })).statusCode).toBe(403);
    expect((await call(bob.id, "GET", "/v1/provider-keys")).statusCode).toBe(403);
  });

  it("invites unknown emails and accepts on first /me", async () => {
    const carolEmail = `carol-${run}@test.local`;
    const res = await call(alice.id, "POST", "/v1/invites", { email: carolEmail.toUpperCase(), role: "builder" });
    expect(res.json()).toEqual({ status: "invited" });
    const carol = { id: `usr_carol_${run}`, email: carolEmail };
    await db.insert(users).values(carol);
    const me = (await call(carol.id, "GET", "/v1/me")).json();
    expect(me.workspaces[0]).toMatchObject({ id: workspaceId, role: "builder" });
  });

  it("keeps at least one owner", async () => {
    const res = await call(alice.id, "PATCH", `/v1/members/${alice.id}`, { role: "admin" });
    expect(res.statusCode).toBe(409);
  });

  it("stores provider keys encrypted and returns them masked", async () => {
    const res = await call(alice.id, "POST", "/v1/provider-keys", {
      provider: "anthropic",
      label: "Main",
      secret: "sk-ant-abcdef9876",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ maskedSecret: "••••9876" });
    expect(JSON.stringify(res.json())).not.toContain("sk-ant");
    const list = (await call(alice.id, "GET", "/v1/provider-keys")).json();
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]).not.toHaveProperty("encSecret");
  });

  it("requires a base URL for Azure OpenAI keys", async () => {
    const res = await call(alice.id, "POST", "/v1/provider-keys", {
      provider: "azure_openai",
      label: "Az",
      secret: "x",
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates, validates, saves and deletes flows", async () => {
    const created = await call(alice.id, "POST", "/v1/flows", { name: "Support bot" });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const flow = (await call(alice.id, "GET", `/v1/flows/${id}`)).json();
    expect(flow.validation.ok).toBe(true);
    expect(flow.draftJson.id).toBe(id);

    const broken = { ...flow.draftJson, edges: [] };
    const saved = (await call(alice.id, "PUT", `/v1/flows/${id}/draft`, { draft: broken })).json();
    expect(saved.validation.ok).toBe(false);

    expect((await call(alice.id, "DELETE", `/v1/flows/${id}`)).statusCode).toBe(204);
    expect((await call(alice.id, "GET", `/v1/flows/${id}`)).statusCode).toBe(404);
  });
});
