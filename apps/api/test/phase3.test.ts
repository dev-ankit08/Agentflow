import { createHmac, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { eq, like } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, flows, orgs, runs, users } from "@agentflow/db";
import type { FlowInput } from "@agentflow/flow-schema";
import { startMockLlm } from "@agentflow/llm-gateway/mock-server";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "../src/app";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";
import { applyRetention, chooseVersion, resumeDueTimers, runSchedules } from "../src/automation";
import { loadRootEnv } from "../src/config";
import { clusterQuestions } from "../src/routes/governance";

// End-to-end Phase 3 features over a real Postgres and the mock model. Skipped without DATABASE_URL.
loadRootEnv();
const url = process.env.DATABASE_URL;
const jwtSecret = "test-secret-at-least-16-chars";
const LLM_PORT = 4932;
const at = { x: 0, y: 0 };

describe("conversation insights clustering", () => {
  it("groups questions by topic and flags problem topics", () => {
    const row = (id: string, message: string, outcome: string | null = "resolved", rating: number | null = null) => ({
      id,
      message,
      outcome,
      status: "completed",
      rating,
    });
    const { clusters, total } = clusterQuestions([
      row("1", "Where is my refund?", "escalated"),
      row("2", "refund still not received", "failed"),
      row("3", "How do refunds work", "resolved", 1),
      row("4", "Track my shipping please"),
      row("5", "shipping times to Pune"),
    ]);
    expect(total).toBe(5);
    expect(clusters[0]).toMatchObject({ topic: "refund", count: 3, escalated: 1, failed: 1, negative: 1 });
    expect(clusters[0]!.suggestion).toMatch(/refund/);
    expect(clusters.find((c) => c.topic === "shipp")).toMatchObject({ count: 2, suggestion: null });
  });
});

describe.skipIf(!url)("Phase 3 API", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const run = randomBytes(4).toString("hex");
  const owner = { id: `usr_p3o_${run}`, email: `p3o-${run}@test.local`, name: "Owner" };
  const builder = { id: `usr_p3b_${run}`, email: `p3b-${run}@test.local`, name: "Builder" };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let llm: Server;
  let workspaceId = "";
  let orgId = "";

  const call = async (as: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: object) => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(as)
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

  async function makeFlow(
    name: string,
    nodes: FlowInput["nodes"],
    edges: FlowInput["edges"],
    extra: Partial<FlowInput> = {},
  ) {
    const { id } = (await call(owner.id, "POST", "/v1/flows", { name })).json();
    const res = await call(owner.id, "PUT", `/v1/flows/${id}/draft`, {
      draft: { schemaVersion: 1, id, name, nodes, edges, ...extra },
    });
    expect(res.json().validation.errors).toEqual([]);
    return id as string;
  }
  const publish = async (flowId: string) => (await call(owner.id, "POST", `/v1/flows/${flowId}/publish`)).json();

  const echoFlow = (message: string): [FlowInput["nodes"], FlowInput["edges"]] => [
    [
      { id: "start", type: "start", label: "Start", position: at, config: {} },
      { id: "end", type: "end", label: "End", position: at, config: { message, output: { got: "trigger.order" } } },
    ],
    [{ id: "1", source: "start", target: "end" }],
  ];

  beforeAll(async () => {
    llm = await startMockLlm(LLM_PORT, { delayMs: 0 });
    app = await buildApp({
      db,
      secrets: createSecretStore(randomBytes(32).toString("base64")),
      jwtSecret,
      corsOrigin: "http://localhost:3100",
      allowPrivateHttp: true,
      sweepIntervalMs: 0,
    });
    await db.insert(users).values([owner, builder]);
    const ws = (await call(owner.id, "POST", "/v1/orgs", { orgName: "Phase3" })).json();
    workspaceId = ws.id;
    orgId = ws.orgId;
    await call(owner.id, "POST", "/v1/invites", { email: builder.email, role: "builder" });
    await call(builder.id, "GET", "/v1/me");
    await call(owner.id, "POST", "/v1/provider-keys", {
      provider: "openai_compatible",
      label: "Mock",
      secret: "mock",
      baseUrl: `http://localhost:${LLM_PORT}/v1`,
    });
  });

  afterAll(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(like(users.id, `%_${run}`));
    await app.close();
    await close();
    await new Promise((r) => llm.close(r));
  });

  it("starts flows from signed webhooks", async () => {
    const flowId = await makeFlow("Hook", ...echoFlow("Got it"));
    await publish(flowId);
    const created = await call(owner.id, "POST", `/v1/flows/${flowId}/webhook`, { signed: true });
    expect(created.statusCode).toBe(200);
    const { url: hookUrl, secret } = created.json();
    const path = new URL(hookUrl).pathname;
    const body = JSON.stringify({ order: "1042" });

    const unsigned = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);

    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const ok = await app.inject({
      method: "POST",
      url: `${path}?wait=true`,
      headers: { "content-type": "application/json", "x-agentflow-signature": sig },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ output: { got: "1042" } });
    const [row] = await db.select().from(runs).where(eq(runs.id, ok.json().runId));
    expect(row?.triggerType).toBe("webhook");

    const triggers = (await call(owner.id, "GET", `/v1/flows/${flowId}/triggers`)).json();
    expect(triggers.webhook).toMatchObject({ signed: true });
    expect((await app.inject({ method: "POST", url: "/v1/hooks/hk_nope", payload: {} })).statusCode).toBe(404);
  });

  it("fires schedules once per matching minute", async () => {
    const [nodes, edges] = echoFlow("Nightly report");
    const flowId = await makeFlow("Nightly", nodes, edges, {
      triggers: [{ type: "schedule", config: { cron: "30 2 * * *", input: { order: "sched" } } }],
    });
    await publish(flowId);
    const minute = new Date("2026-11-02T02:30:10Z");
    const first = await runSchedules(db, app.deps.executor, minute);
    const mine = (await db.select().from(runs).where(eq(runs.flowId, flowId))).filter((r) => first.includes(r.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.triggerType).toBe("schedule");
    const again = await runSchedules(db, app.deps.executor, minute);
    expect(
      (await db.select().from(runs).where(eq(runs.flowId, flowId))).filter((r) => again.includes(r.id)),
    ).toHaveLength(0);
    const triggers = (await call(owner.id, "GET", `/v1/flows/${flowId}/triggers`)).json();
    expect(triggers.schedule).toMatchObject({ cron: "30 2 * * *", lastRunAt: "2026-11-02T02:30:00.000Z" });
  });

  it("resumes Wait nodes when their time comes", async () => {
    const flowId = await makeFlow(
      "Follow up",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "wait", type: "wait", label: "Wait a day", position: at, config: { minutes: 1440 } },
        { id: "end", type: "end", label: "End", position: at, config: { message: "Following up!" } },
      ],
      [
        { id: "1", source: "start", target: "wait" },
        { id: "2", source: "wait", target: "end" },
      ],
    );
    const { widgetKey } = (await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json();
    await publish(flowId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      payload: { message: "hi" },
    });
    const runId = /"runId":"(run_[^"]+)"/.exec(res.body)![1]!;
    const [paused] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(paused?.status).toBe("waiting_timer");

    expect(await resumeDueTimers(db, app.deps.executor)).toBe(0);
    expect(await resumeDueTimers(db, app.deps.executor, new Date(Date.now() + 1441 * 60_000))).toBe(1);
    const [done] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(done?.status).toBe("waiting_input");
    expect(JSON.stringify(done?.state)).toContain("Following up!");
  });

  it("remembers end users and erases them on request", async () => {
    const flowId = await makeFlow(
      "Memory",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "save",
          type: "memory",
          label: "Save",
          position: at,
          config: { mode: "write", facts: '["Prefers email updates"]' },
        },
        { id: "recall", type: "memory", label: "Recall", position: at, config: { mode: "read" } },
        { id: "end", type: "end", label: "End", position: at, config: { message: "{{recall.text}}" } },
      ],
      [
        { id: "1", source: "start", target: "save" },
        { id: "2", source: "save", target: "recall" },
        { id: "3", source: "recall", target: "end" },
      ],
    );
    const { widgetKey } = (await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json();
    await publish(flowId);
    const { secret } = (await call(owner.id, "POST", `/v1/flows/${flowId}/widget/identity-secret`)).json();
    const identityToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(`cust_${run}`)
      .sign(new TextEncoder().encode(secret));
    const res = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      payload: { message: "email me", identityToken },
    });
    expect(res.body).toContain("Prefers email updates");

    const stored = (await call(owner.id, "GET", `/v1/end-users/cust_${run}`)).json();
    expect(stored.memories.map((m: { fact: string }) => m.fact)).toEqual(["Prefers email updates"]);
    expect(stored.conversations).toBe(1);
    expect((await call(builder.id, "DELETE", `/v1/end-users/cust_${run}`)).statusCode).toBe(403);
    const erased = (await call(owner.id, "DELETE", `/v1/end-users/cust_${run}`)).json();
    expect(erased).toEqual({ memories: 1, conversations: 1 });
    expect((await call(owner.id, "GET", `/v1/end-users/cust_${run}`)).json()).toMatchObject({
      memories: [],
      conversations: 0,
    });
  });

  it("records configuration changes in the audit log", async () => {
    await call(owner.id, "PUT", "/v1/workspace/settings", { retention: { days: 90 } });
    const log = (await call(owner.id, "GET", "/v1/audit")).json();
    const actions = log.events.map((e: { action: string }) => e.action);
    expect(actions).toContain("Changed workspace settings");
    expect(actions).toContain("Published flow");
    expect(actions).toContain("Deleted end-user data");
    expect(actions).not.toContain("PUT /v1/flows/:id/draft");
    expect(log.events[0]).toMatchObject({ actorEmail: owner.email });

    const csv = await call(owner.id, "GET", "/v1/audit?format=csv");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("time,actor,action,target_type,target_id,detail");
    expect((await call(builder.id, "GET", "/v1/audit")).statusCode).toBe(403);
  });

  it("applies retention: old runs are deleted and zero retention keeps no transcripts", async () => {
    const flowId = await makeFlow("Retention", ...echoFlow("Hello"));
    await publish(flowId);
    const { widgetKey } = (await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json();

    await call(owner.id, "PUT", "/v1/workspace/settings", { retention: { zeroRetention: true } });
    const res = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      payload: { message: "my card is 4111" },
    });
    const runId = /"runId":"(run_[^"]+)"/.exec(res.body)![1]!;
    const steps = await app.deps.store.load(runId);
    expect(steps?.status).toBe("waiting_input");
    // Idle chats are scrubbed by the retention sweep.
    await db
      .update(runs)
      .set({ startedAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(runs.id, runId));
    const swept = await applyRetention(db);
    expect(swept.scrubbed).toBeGreaterThanOrEqual(1);
    const [scrubbed] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(JSON.stringify(scrubbed?.state)).not.toContain("4111");

    await call(owner.id, "PUT", "/v1/workspace/settings", { retention: { days: 30 } });
    await db
      .update(runs)
      .set({ startedAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(runs.id, runId));
    expect((await applyRetention(db)).deleted).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(runs).where(eq(runs.id, runId))).toHaveLength(0);
    await call(owner.id, "PUT", "/v1/workspace/settings", { retention: {} });
  });

  it("splits traffic in an A/B test and promotes the challenger", async () => {
    const flowId = await makeFlow("AB", ...echoFlow("Version A"));
    const v1 = await publish(flowId);
    const [nodes, edges] = echoFlow("Version B");
    await call(owner.id, "PUT", `/v1/flows/${flowId}/draft`, {
      draft: { schemaVersion: 1, id: flowId, name: "AB", nodes, edges },
    });
    // Publishing B makes it live; roll back to A so B can be the challenger.
    const v2 = await publish(flowId);
    await call(owner.id, "POST", `/v1/flows/${flowId}/versions/${v1.id}/rollback`);

    expect(
      (await call(owner.id, "PUT", `/v1/flows/${flowId}/ab-test`, { versionId: v1.id, percent: 50 })).statusCode,
    ).toBe(400);
    const started = await call(owner.id, "PUT", `/v1/flows/${flowId}/ab-test`, { versionId: v2.id, percent: 50 });
    expect(started.statusCode).toBe(200);

    const [flow] = await db.select().from(flows).where(eq(flows.id, flowId));
    expect((await chooseVersion(db, flow!, () => 0.1))?.id).toBe(v2.id);
    expect((await chooseVersion(db, flow!, () => 0.9))?.id).toBe(v1.id);

    const stats = (await call(owner.id, "GET", `/v1/flows/${flowId}/ab-test`)).json();
    expect(stats.stats.map((s: { role: string }) => s.role)).toEqual(["live", "challenger"]);

    const promoted = await call(owner.id, "POST", `/v1/flows/${flowId}/ab-test/promote`);
    expect(promoted.json()).toEqual({ liveVersionId: v2.id });
    expect((await call(owner.id, "GET", `/v1/flows/${flowId}/ab-test`)).json().abTest).toBeNull();
  });

  it("indexes knowledge with the embedding model and searches it semantically", async () => {
    const before = (await call(owner.id, "GET", "/v1/knowledge/index")).json();
    expect(before.model).toBeNull();

    expect(
      (
        await call(owner.id, "PUT", "/v1/workspace/settings", {
          embedding: { provider: "openai_compatible", name: "mock-embed" },
        })
      ).statusCode,
    ).toBe(200);
    const added = await call(owner.id, "POST", "/v1/knowledge", {
      type: "text",
      name: "Warranty",
      content:
        "Every backpack carries a lifetime warranty against manufacturing defects.\n\nTents are covered for two years.",
    });
    expect(added.statusCode).toBe(201);

    // New passages are indexed straight away.
    const status = (await call(owner.id, "GET", "/v1/knowledge/index")).json();
    expect(status).toMatchObject({ model: { provider: "openai_compatible", name: "mock-embed" } });
    expect(status.indexed).toBe(status.total);
    expect(status.total).toBeGreaterThan(0);

    const hits = (await call(owner.id, "POST", "/v1/knowledge/search", { query: "backpack warranty", topK: 2 })).json();
    expect(hits.results[0].text).toContain("lifetime warranty");

    // A model that can't embed falls back to full-text search instead of failing.
    await call(owner.id, "PUT", "/v1/workspace/settings", { embedding: { provider: "openai", name: "no-key" } });
    const fallback = (await call(owner.id, "POST", "/v1/knowledge/search", { query: "backpack warranty" })).json();
    expect(fallback.results[0].text).toContain("lifetime warranty");
    await call(owner.id, "PUT", "/v1/workspace/settings", { embedding: null });
  });

  it("supports presence, node comments and edit-conflict protection", async () => {
    const flowId = await makeFlow("Collab", ...echoFlow("Hi"));
    await call(owner.id, "POST", `/v1/flows/${flowId}/presence`, { nodeId: "end" });
    const seen = (await call(builder.id, "POST", `/v1/flows/${flowId}/presence`, {})).json();
    expect(seen.others).toEqual([{ userId: owner.id, name: "Owner", nodeId: "end" }]);

    const comment = await call(builder.id, "POST", `/v1/flows/${flowId}/comments`, {
      nodeId: "end",
      body: "Make this friendlier",
    });
    expect(comment.statusCode).toBe(201);
    const resolved = await call(owner.id, "PATCH", `/v1/flows/${flowId}/comments/${comment.json().id}`, {
      resolved: true,
    });
    expect(resolved.json().resolvedAt).toBeTruthy();
    expect((await call(owner.id, "GET", `/v1/flows/${flowId}/comments`)).json().comments).toHaveLength(1);

    const loaded = (await call(owner.id, "GET", `/v1/flows/${flowId}`)).json();
    const [nodes, edges] = echoFlow("Edited by builder");
    const draft = { schemaVersion: 1, id: flowId, name: "Collab", nodes, edges };
    const first = await call(builder.id, "PUT", `/v1/flows/${flowId}/draft`, {
      draft,
      baseUpdatedAt: loaded.updatedAt,
    });
    expect(first.statusCode).toBe(200);
    const stale = await call(owner.id, "PUT", `/v1/flows/${flowId}/draft`, { draft, baseUpdatedAt: loaded.updatedAt });
    expect(stale.statusCode).toBe(409);
    const fresh = await call(owner.id, "PUT", `/v1/flows/${flowId}/draft`, {
      draft,
      baseUpdatedAt: first.json().updatedAt,
    });
    expect(fresh.statusCode).toBe(200);
  });
});
