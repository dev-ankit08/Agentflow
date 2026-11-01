import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { SignJWT } from "jose";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectors, createDb, orgs, providerKeys, users, workspaces } from "@agentflow/db";
import { startDemoServer } from "@agentflow/mcp-client/demo-server";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "../src/app";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";
import { loadRootEnv } from "../src/config";
import { DEMO_CONNECTOR_NAME, DEMO_MODEL_LABEL, provisionTrialDemo } from "../src/trial";

loadRootEnv();
const url = process.env.DATABASE_URL;
const jwtSecret = "test-secret-at-least-16-chars";
const MCP_PORT = 4321;

describe.skipIf(!url)("hosted trial demo", () => {
  const { db, close } = createDb(url ?? "", { max: 2 });
  const run = randomBytes(4).toString("hex");
  const user = { id: `usr_trial_${run}`, email: `trial-${run}@test.local` };
  const secrets = createSecretStore(randomBytes(32).toString("base64"));
  const demo = { modelUrl: "http://localhost:4010/v1", mcpUrl: `http://localhost:${MCP_PORT}/mcp` };
  const orgIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;
  let server: Server;

  const token = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));

  beforeAll(async () => {
    server = await startDemoServer(MCP_PORT);
    app = await buildApp({ db, secrets, jwtSecret, corsOrigin: "http://localhost:3100", trialDemo: demo });
    await db.insert(users).values(user);
  });

  afterAll(async () => {
    for (const id of orgIds) await db.delete(orgs).where(eq(orgs.id, id));
    await db.delete(users).where(like(users.id, `%_${run}`));
    await app.close();
    await new Promise((r) => server.close(r));
    await close();
  });

  it("gives a new workspace the demo model and the demo orders connector", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: { authorization: `Bearer ${await token()}` },
      payload: { orgName: `Trial ${run}` },
    });
    expect(res.statusCode).toBe(201);
    const ws = res.json() as { id: string; orgId: string };
    orgIds.push(ws.orgId);

    const keys = await db.select().from(providerKeys).where(eq(providerKeys.workspaceId, ws.id));
    expect(keys).toMatchObject([{ provider: "openai_compatible", label: DEMO_MODEL_LABEL, baseUrl: demo.modelUrl }]);
    const cons = await db.select().from(connectors).where(eq(connectors.workspaceId, ws.id));
    expect(cons).toHaveLength(1);
    expect(cons[0]).toMatchObject({ name: DEMO_CONNECTOR_NAME });
    expect(cons[0]!.toolCatalog.map((t) => t.name)).toContain("get_order");
  });

  it("leaves workspaces that already have their own key or connector alone", async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `Own keys ${run}` })
      .returning();
    orgIds.push(org!.id);
    const [ws] = await db.insert(workspaces).values({ orgId: org!.id, name: "Default" }).returning();
    await db.insert(providerKeys).values({
      workspaceId: ws!.id,
      provider: "anthropic",
      label: "Mine",
      encSecret: secrets.encrypt("sk-test"),
      maskedSecret: "••••test",
    });

    const result = await provisionTrialDemo(db, secrets, demo, ws!.id);
    expect(result).toEqual({ models: 0, connectors: 1 });
    const keys = await db.select().from(providerKeys).where(eq(providerKeys.workspaceId, ws!.id));
    expect(keys.map((k) => k.label)).toEqual(["Mine"]);
    expect(await provisionTrialDemo(db, secrets, demo, ws!.id)).toEqual({ models: 0, connectors: 0 });
  });
});
