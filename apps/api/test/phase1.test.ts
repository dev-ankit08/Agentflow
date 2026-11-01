import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { eq, like } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, orgs, users } from "@agentflow/db";
import { startMockLlm } from "@agentflow/llm-gateway/mock-server";
import { startDemoServer } from "@agentflow/mcp-client/demo-server";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "../src/app";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";
import { loadRootEnv } from "../src/config";

// End-to-end over real HTTP: mock model server + demo MCP server + Postgres. Skipped without DATABASE_URL.
loadRootEnv();
const url = process.env.DATABASE_URL;
const jwtSecret = "test-secret-at-least-16-chars";
const LLM_PORT = 4911;
const MCP_PORT = 4912;

type Event = { type: string; runId?: string; content?: string; nodeId?: string; [k: string]: unknown };
const parseSse = (body: string): Event[] =>
  body
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)));

describe.skipIf(!url)("Phase 1 API", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const run = randomBytes(4).toString("hex");
  const owner = { id: `usr_p1_${run}`, email: `p1-${run}@test.local` };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let servers: Server[] = [];
  let workspaceId = "";
  let orgId = "";
  let connectorId = "";
  let flowId = "";
  let widgetKey = "";

  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: object) => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(owner.id)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));
    return app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, ...(workspaceId ? { "x-workspace-id": workspaceId } : {}) },
      ...(body ? { payload: body } : {}),
    });
  };

  beforeAll(async () => {
    servers = [await startMockLlm(LLM_PORT, { delayMs: 0 }), await startDemoServer(MCP_PORT)];
    app = await buildApp({
      db,
      secrets: createSecretStore(randomBytes(32).toString("base64")),
      jwtSecret,
      corsOrigin: "http://localhost:3100",
      allowPrivateHttp: true,
    });
    await db.insert(users).values(owner);
    const ws = (await call("POST", "/v1/orgs", { orgName: "Phase1" })).json();
    workspaceId = ws.id;
    orgId = ws.orgId;
  });

  afterAll(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(like(users.id, `%_${run}`));
    await app.close();
    await close();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  it("connects an MCP server and discovers its tools", async () => {
    const res = await call("POST", "/v1/connectors", {
      name: "Demo orders",
      config: { transport: "http", url: `http://localhost:${MCP_PORT}/mcp` },
    });
    expect(res.statusCode).toBe(201);
    connectorId = res.json().id;
    expect(res.json().toolCatalog.map((t: { name: string }) => t.name)).toContain("get_order");

    const test = await call("POST", `/v1/connectors/${connectorId}/test`, {
      tool: "get_order",
      args: { order_id: "1042" },
    });
    expect(test.json()).toMatchObject({ isError: false, data: { status: "shipped" } });
  });

  it("refuses connectors it cannot reach", async () => {
    const res = await call("POST", "/v1/connectors", {
      name: "Down",
      config: { transport: "http", url: "http://localhost:1/mcp" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("lists templates and installs one with the chosen model and connector", async () => {
    const list = (await call("GET", "/v1/templates")).json();
    expect(list.templates).toHaveLength(5);
    await call("POST", "/v1/provider-keys", {
      provider: "openai_compatible",
      label: "Mock",
      secret: "mock",
      baseUrl: `http://localhost:${LLM_PORT}/v1`,
    });
    const res = await call("POST", "/v1/templates/order-status/install", {
      model: { provider: "openai_compatible", name: "mock-1" },
      connectorId,
    });
    expect(res.statusCode).toBe(201);
    flowId = res.json().id;
    const flow = (await call("GET", `/v1/flows/${flowId}`)).json();
    expect(flow.validation.ok).toBe(true);
  });

  it("streams a test run of the draft and continues the conversation", async () => {
    const res = await call("POST", `/v1/flows/${flowId}/test-runs`, {
      message: "Where is order 1042?",
      user: { plan: "vip" },
    });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(res.body);
    const runId = (events[0] as { runId: string }).runId;
    expect(events.filter((e) => e.type === "step_started").map((e) => e.nodeId)).toEqual([
      "start",
      "triage",
      "route",
      "lookup",
      "answer",
      "done",
    ]);
    expect((events.find((e) => e.type === "message") as { content: string }).content).toContain("Thursday");
    expect(events.at(-1)).toEqual({ type: "waiting_input" });

    const next = parseSse((await call("POST", `/v1/runs/${runId}/messages`, { message: "I want a refund" })).body);
    expect(next.filter((e) => e.type === "step_started").map((e) => e.nodeId)).toEqual([
      "start",
      "triage",
      "route",
      "refund",
    ]);

    const detail = (await call("GET", `/v1/runs/${runId}`)).json();
    expect(detail.steps).toHaveLength(10);
    expect(detail.state.outcome).toBe("escalated");
    expect(detail.steps.find((s: { nodeId: string }) => s.nodeId === "triage").model).toBe("openai_compatible/mock-1");
    const runs = (await call("GET", "/v1/runs")).json().runs;
    expect(runs[0]).toMatchObject({ id: runId, turns: 2, firstMessage: "Where is order 1042?" });
  });

  it("publishes versions and rolls back", async () => {
    const v1 = await call("POST", `/v1/flows/${flowId}/publish`);
    expect(v1.json()).toMatchObject({ version: 1 });
    const v2 = (await call("POST", `/v1/flows/${flowId}/publish`)).json();
    expect(v2.version).toBe(2);
    const versions = (await call("GET", `/v1/flows/${flowId}/versions`)).json();
    expect(versions.versions.map((v: { status: string }) => v.status)).toEqual(["live", "archived"]);
    const rb = (await call("POST", `/v1/flows/${flowId}/versions/${v1.json().id}/rollback`)).json();
    expect(rb.version).toBe(1);
  });

  it("serves the widget only to allowed origins and keeps sessions private", async () => {
    const widget = (await call("GET", `/v1/flows/${flowId}/widget`)).json();
    widgetKey = widget.widgetKey;

    const local = await app.inject({
      method: "GET",
      url: `/v1/widget/${widgetKey}/config`,
      headers: { origin: "http://localhost:5500" },
    });
    expect(local.json()).toMatchObject({ live: true, title: "Assistant" });
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:5500");
    const foreign = await app.inject({
      method: "GET",
      url: `/v1/widget/${widgetKey}/config`,
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.statusCode).toBe(403);

    await call("PUT", `/v1/flows/${flowId}/widget`, {
      title: "Acme Help",
      welcome: "Hi!",
      color: "#112233",
      allowedOrigins: ["https://shop.example"],
      quickReplies: ["Track order"],
    });
    const allowed = await app.inject({
      method: "GET",
      url: `/v1/widget/${widgetKey}/config`,
      headers: { origin: "https://shop.example" },
    });
    expect(allowed.json()).toMatchObject({ title: "Acme Help", quickReplies: ["Track order"] });

    const start = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      headers: { origin: "https://shop.example" },
      payload: { message: "status of 1043?" },
    });
    const events = parseSse(start.body);
    const session = start.body.split("\n\n").find((b) => b.startsWith("event: session"))!;
    const { runId, sessionToken } = JSON.parse(session.split("data: ")[1]!);
    expect((events.find((e) => e.type === "message") as { content: string }).content).toContain("processing");

    const hijack = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions/${runId}/messages`,
      headers: { origin: "https://shop.example" },
      payload: { message: "hi", sessionToken: "forged" },
    });
    expect(hijack.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions/${runId}/messages`,
      headers: { origin: "https://shop.example" },
      payload: { message: "and 1044?", sessionToken },
    });
    expect(parseSse(ok.body).at(-1)).toEqual({ type: "waiting_input" });
  });

  it("verifies signed end-user identity tokens", async () => {
    const { secret } = (await call("POST", `/v1/flows/${flowId}/widget/identity-secret`)).json();
    const identityToken = await new SignJWT({ email: "jane@shop.example", plan: "vip" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("cust_9")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(secret));
    const res = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      headers: { origin: "https://shop.example" },
      payload: { message: "where is 1042", identityToken },
    });
    const runId = (parseSse(res.body)[0] as { runId: string }).runId;
    const detail = (await call("GET", `/v1/runs/${runId}`)).json();
    expect(detail.endUserId).toBe("cust_9");
    expect(detail.state.user).toMatchObject({ id: "cust_9", plan: "vip" });

    const bad = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      headers: { origin: "https://shop.example" },
      payload: { message: "x", identityToken: "nope" },
    });
    expect(bad.statusCode).toBe(401);
  });
});
