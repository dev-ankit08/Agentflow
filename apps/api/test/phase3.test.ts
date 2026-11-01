import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, like } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { createDb, flows, orgs, runSteps, runs, users } from "@agentflow/db";
import type { FlowInput } from "@agentflow/flow-schema";
import { LLMGateway } from "@agentflow/llm-gateway";
import { startMockLlm } from "@agentflow/llm-gateway/mock-server";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "../src/app";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";
import { COLLAB_AUDIENCE } from "../src/collab";
import { applyRetention, chooseVersion, extractMemories, resumeDueTimers, runSchedules } from "../src/automation";
import { loadRootEnv } from "../src/config";
import { ROUTE_PERMISSIONS } from "../src/permissions";
import { sendDueReports } from "../src/reports";
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
  const mails: { to: string; subject: string; text: string }[] = [];
  const slackPosts: { url: string; text: string }[] = [];

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
      notifier: {
        sendMail: async (m) => void mails.push(m),
        postSlack: async (url, body) => void slackPosts.push({ url, text: body.text }),
      },
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

  it("runs batches, files, HubSpot-signed events and inbound email", async () => {
    const flowId = await makeFlow("Intake", ...echoFlow("Handled"));
    await publish(flowId);
    const post = (path: string, payload: string, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: path, headers: { "content-type": "application/json", ...headers }, payload });

    // Batch mode: a JSON array starts one run per item.
    const created = (
      await call(owner.id, "POST", `/v1/flows/${flowId}/webhook`, { signed: false, batch: true })
    ).json();
    const hook = new URL(created.url).pathname;
    const batch = await post(`${hook}?wait=true`, JSON.stringify([{ order: "A1" }, { order: "A2" }, { order: "A3" }]));
    expect(batch.json().runs.map((r: { output: { got: string } }) => r.output.got)).toEqual(["A1", "A2", "A3"]);

    // A CSV file: one run per row in batch mode, or all rows in one run otherwise.
    const csv = 'order,note\nB1,"needs ""gift"" wrap"\nB2,plain\n';
    const rows = await post(`${hook}/file?wait=true`, csv, { "content-type": "text/csv", "x-filename": "orders.csv" });
    expect(rows.json().runs).toHaveLength(2);
    await call(owner.id, "PATCH", `/v1/flows/${flowId}/webhook`, { batch: false });
    const single = await post(`${hook}/file?wait=true`, csv, { "content-type": "text/csv" });
    const [run1] = await db.select().from(runs).where(eq(runs.id, single.json().runId));
    expect((run1?.state as { trigger: { rows: unknown[] } }).trigger.rows).toEqual([
      { order: "B1", note: 'needs "gift" wrap' },
      { order: "B2", note: "plain" },
    ]);

    // HubSpot v3 signatures are checked with the app's client secret.
    const hub = (
      await call(owner.id, "POST", `/v1/flows/${flowId}/webhook`, {
        signature: "hubspot",
        secret: "hubspot-client-secret",
      })
    ).json();
    const hubPath = new URL(hub.url).pathname;
    const body = JSON.stringify([{ objectId: 42, subscriptionType: "deal.creation" }]);
    const timestamp = String(Date.now());
    const sign = (secret: string) =>
      createHmac("sha256", secret)
        .update(`POST${"http://localhost:4000"}${hubPath}${body}${timestamp}`)
        .digest("base64");
    const headers = { "x-hubspot-request-timestamp": timestamp };
    expect((await post(hubPath, body, { ...headers, "x-hubspot-signature-v3": sign("wrong") })).statusCode).toBe(401);
    expect(
      (await post(hubPath, body, { ...headers, "x-hubspot-signature-v3": sign("hubspot-client-secret") })).statusCode,
    ).toBe(202);

    // Inbound email, as Postmark JSON or Mailgun form fields.
    const email = (await call(owner.id, "POST", `/v1/flows/${flowId}/email-hook`)).json();
    const emailPath = new URL(email.url).pathname;
    const postmark = await post(
      `${emailPath}?wait=true`,
      JSON.stringify({ From: "ana@example.com", Subject: "Order help", TextBody: "Where is order 77?" }),
    );
    const [mailRun] = await db.select().from(runs).where(eq(runs.id, postmark.json().runId));
    expect(mailRun?.triggerType).toBe("email");
    expect((mailRun?.state as { trigger: Record<string, unknown> }).trigger).toMatchObject({
      message: "Where is order 77?",
      email: { from: "ana@example.com", subject: "Order help" },
    });
    const mailgun = await app.inject({
      method: "POST",
      url: emailPath,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        sender: "bo@example.com",
        subject: "Hi",
        "stripped-text": "Cancel please",
      }).toString(),
    });
    expect(mailgun.statusCode).toBe(202);
    const triggers = (await call(owner.id, "GET", `/v1/flows/${flowId}/triggers`)).json();
    expect(triggers).toMatchObject({ webhook: { signature: "hubspot", batch: false }, email: { url: email.url } });
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

  it("learns facts from idle conversations in the background, once per new activity", async () => {
    const flowId = await makeFlow("Remembering", ...echoFlow("Noted!"));
    const { widgetKey } = (await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json();
    await publish(flowId);
    const { secret } = (await call(owner.id, "POST", `/v1/flows/${flowId}/widget/identity-secret`)).json();
    const identityToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(`mem_${run}`)
      .sign(new TextEncoder().encode(secret));
    const res = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      payload: { message: "Please only contact me by email", identityToken },
    });
    const runId = /"runId":"(run_[^"]+)"/.exec(res.body)![1]!;

    const saved = await call(owner.id, "PUT", "/v1/workspace/settings", {
      memoryExtraction: {
        enabled: true,
        model: { provider: "openai_compatible", name: "fact-model" },
        idleMinutes: 30,
      },
    });
    expect(saved.statusCode).toBe(200);
    // A stand-in model that always finds one fact.
    const gateway = new LLMGateway({
      resolveCredentials: async () => ({ apiKey: "k" }),
      providers: {
        openai_compatible: {
          id: "openai_compatible",
          chat: async () => ({
            text: '{"facts":["Prefers to be contacted by email"]}',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "stop",
          }),
        },
      },
    });
    const noBudgetLimit = async () => {};

    // Not yet idle long enough.
    await extractMemories(db, () => gateway, noBudgetLimit);
    let [row] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(row?.memoryExtractedAt).toBeNull();

    const later = new Date(Date.now() + 31 * 60_000);
    await extractMemories(db, () => gateway, noBudgetLimit, later);
    [row] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(row?.memoryExtractedAt).toBeTruthy();
    const facts = (await call(owner.id, "GET", `/v1/end-users/mem_${run}`)).json().memories;
    expect(facts.map((m: { fact: string }) => m.fact)).toEqual(["Prefers to be contacted by email"]);

    // Already learned and no new activity: not processed again.
    await extractMemories(db, () => gateway, noBudgetLimit, new Date(Date.now() + 62 * 60_000));
    const [again] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(again?.memoryExtractedAt?.getTime()).toBe(row?.memoryExtractedAt?.getTime());
    await call(owner.id, "PUT", "/v1/workspace/settings", { memoryExtraction: null });
  });

  it("notifies approvers by email and Slack, with signed links that decide on confirmation", async () => {
    await call(owner.id, "PUT", "/v1/workspace/settings", {
      notifications: { emailApprovers: true, slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/xyz" },
    });
    const flowId = await makeFlow(
      "Approve me",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "ok",
          type: "approval",
          label: "Check",
          position: at,
          config: { message: "Refund 40 for {{trigger.message}}" },
        },
        { id: "yes", type: "end", label: "Yes", position: at, config: { message: "Approved!" } },
        { id: "no", type: "end", label: "No", position: at, config: { message: "Declined" } },
      ],
      [
        { id: "1", source: "start", target: "ok" },
        { id: "2", source: "ok", sourceHandle: "approved", target: "yes" },
        { id: "3", source: "ok", sourceHandle: "rejected", target: "no" },
        { id: "4", source: "ok", sourceHandle: "timeout", target: "no" },
      ],
    );
    const { widgetKey } = (await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json();
    await publish(flowId);
    mails.length = 0;
    slackPosts.length = 0;
    const res = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      payload: { message: "order 9" },
    });
    const runId = /"runId":"(run_[^"]+)"/.exec(res.body)![1]!;
    // Every member at or above the approver role (reviewer) is emailed: here the owner and the builder.
    await expect.poll(() => mails.length).toBe(2);
    expect(mails.map((m) => m.to).sort()).toEqual([builder.email, owner.email].sort());
    const ownerMail = mails.find((m) => m.to === owner.email)!;
    expect(ownerMail.subject).toBe("Approval needed: Approve me");
    expect(ownerMail.text).toContain("Refund 40 for order 9");
    expect(slackPosts[0]).toMatchObject({ url: "https://hooks.slack.com/services/T0/B0/xyz" });
    expect(slackPosts[0]!.text).toContain("Refund 40 for order 9");

    const approveLink = new URL(/Approve: (\S+)/.exec(ownerMail.text)![1]!);
    const path = approveLink.pathname + approveLink.search;
    // Opening the link only shows a confirmation page.
    const confirm = await app.inject({ method: "GET", url: path });
    expect(confirm.body).toContain("Approve this request?");
    let [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.status).toBe("waiting_approval");

    // A tampered link is refused; the real one decides on POST.
    const form = Object.fromEntries(approveLink.searchParams);
    const tampered = await app.inject({
      method: "POST",
      url: approveLink.pathname,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...form, d: "reject" }).toString(),
    });
    expect(tampered.statusCode).toBe(403);
    const decided = await app.inject({
      method: "POST",
      url: approveLink.pathname,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...form, note: "fine" }).toString(),
    });
    expect(decided.body).toContain("Approved");
    [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.status).toBe("waiting_input");
    expect((await app.inject({ method: "GET", url: path })).body).toContain("Already decided");

    // Slack can be removed while keeping email.
    await call(owner.id, "PUT", "/v1/workspace/settings", {
      notifications: { emailApprovers: true, slackWebhookUrl: null },
    });
    const settings = (await call(owner.id, "GET", "/v1/workspace/settings")).json().settings;
    expect(settings.notifications).toEqual({ emailApprovers: true });
  });

  it("imports and exports eval cases as CSV, and exports analytics as CSV", async () => {
    const flowId = await makeFlow("CSV evals", ...echoFlow("Hi"));
    const ds = (await call(owner.id, "POST", `/v1/flows/${flowId}/evals`, { name: "Imported" })).json();
    // Excel-style file: byte-order mark, alias column names, quoted commas, a blank-input row.
    const csv =
      '﻿Question,Expected,Outcome\n"Where is order 12, please?",shipped,resolved\n,ignored,\nRefund?,,escalated\n';
    const imported = await call(owner.id, "POST", `/v1/evals/${ds.id}/cases/import`, { csv });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toEqual({ added: 2, skipped: 1 });
    expect(
      (await call(owner.id, "POST", `/v1/evals/${ds.id}/cases/import`, { csv: "foo,bar\n1,2\n" })).statusCode,
    ).toBe(400);

    const exported = await call(owner.id, "GET", `/v1/evals/${ds.id}/cases.csv`);
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.body.split("\n")).toEqual([
      "input,contains,outcome,rubric",
      '"Where is order 12, please?",shipped,resolved,',
      "Refund?,,escalated,",
    ]);

    const daily = await call(owner.id, "GET", "/v1/analytics?days=7&format=csv");
    expect(daily.body.split("\n")[0]).toBe("day,conversations,automated,hours_saved,gross_savings_usd");
    const byFlow = await call(owner.id, "GET", "/v1/analytics?days=7&format=csv&table=flows");
    expect(byFlow.body.split("\n")[0]).toBe("flow,conversations,automated,escalated,automation_rate");
  });

  it("keeps a workspace prompt library", async () => {
    const created = await call(builder.id, "POST", "/v1/prompts", {
      name: "Friendly tone",
      body: "Be warm and concise.{{#if user.name}} Greet {{user.name}}.{{/if}}",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(
      (await call(builder.id, "POST", "/v1/prompts", { name: "Leaky", body: "Key {{secret.STRIPE}}" })).statusCode,
    ).toBe(400);
    expect((await call(builder.id, "POST", "/v1/prompts", { name: "Broken", body: "{{#if x}}open" })).statusCode).toBe(
      400,
    );

    const edited = await call(builder.id, "PUT", `/v1/prompts/${id}`, {
      name: "Friendly tone",
      description: "Default support voice",
      body: "Be warm.",
    });
    expect(edited.json()).toMatchObject({ body: "Be warm.", description: "Default support voice" });
    const list = (await call(owner.id, "GET", "/v1/prompts")).json().prompts;
    expect(list.map((p: { name: string }) => p.name)).toContain("Friendly tone");
    expect((await call(builder.id, "DELETE", `/v1/prompts/${id}`)).statusCode).toBe(204);
    expect((await call(builder.id, "PUT", `/v1/prompts/${id}`, { name: "x", body: "y" })).statusCode).toBe(404);
  });

  it("answers repeated and reworded questions from the response cache", async () => {
    const flowId = await makeFlow(
      "Cached FAQ",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "faq",
          type: "agent",
          label: "FAQ",
          position: at,
          config: {
            model: { provider: "openai_compatible", name: "mock-1" },
            systemPrompt: "Answer store questions.",
            userPrompt: "{{trigger.message}}",
          },
        },
        { id: "end", type: "end", label: "End", position: at, config: { message: "{{faq.text}}" } },
      ],
      [
        { id: "1", source: "start", target: "faq" },
        { id: "2", source: "faq", target: "end" },
      ],
    );
    const { widgetKey } = (await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json();
    await publish(flowId);
    const ask = async (message: string) => {
      const res = await app.inject({ method: "POST", url: `/v1/widget/${widgetKey}/sessions`, payload: { message } });
      const runId = /"runId":"(run_[^"]+)"/.exec(res.body)![1]!;
      const [step] = await db
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, runId), eq(runSteps.nodeId, "faq")));
      return step!;
    };

    // Off by default.
    await ask("Opening hours today?");
    expect((await ask("Opening hours today?")).model).toBe("openai_compatible/mock-1");

    await call(owner.id, "PUT", "/v1/workspace/settings", {
      cache: { enabled: true, ttlHours: 24, similar: true },
      embedding: { provider: "openai_compatible", name: "mock-embed" },
    });
    expect((await ask("Opening hours today?")).model).toBe("openai_compatible/mock-1"); // stored
    const exact = await ask("  opening HOURS today?");
    expect(exact).toMatchObject({ model: "cache (openai_compatible/mock-1)", tokensIn: 0 });
    const reworded = await ask("Today, opening hours?");
    expect(reworded.model).toBe("cache (openai_compatible/mock-1)");
    expect((await ask("Do you ship abroad?")).model).toBe("openai_compatible/mock-1");

    const stats = (await call(owner.id, "GET", "/v1/workspace/settings")).json().cache;
    expect(stats.hits).toBeGreaterThanOrEqual(2);
    await call(owner.id, "PUT", "/v1/workspace/settings", {
      cache: { enabled: false, ttlHours: 24, similar: false },
      embedding: null,
    });
  });

  it("emails weekly ROI reports to admins once on the chosen day", async () => {
    const monday9 = new Date("2026-11-02T09:15:00Z"); // a Monday
    await call(owner.id, "PUT", "/v1/workspace/settings", {
      reports: { enabled: true, weekday: 1, hourUtc: 8, extraRecipients: ["ceo@example.com"] },
    });
    mails.length = 0;
    const { notifier } = app.deps;
    // Wrong day, then too early in the day: nothing is sent.
    await sendDueReports(db, notifier, "http://localhost:3100", new Date("2026-11-03T09:15:00Z"));
    await sendDueReports(db, notifier, "http://localhost:3100", new Date("2026-11-02T07:15:00Z"));
    expect(mails.filter((m) => [owner.email, "ceo@example.com"].includes(m.to))).toHaveLength(0);

    await sendDueReports(db, notifier, "http://localhost:3100", monday9);
    const mine = mails.filter((m) => [owner.email, builder.email, "ceo@example.com"].includes(m.to));
    // Owners/admins and extra recipients get it; builders don't.
    expect(mine.map((m) => m.to).sort()).toEqual(["ceo@example.com", owner.email].sort());
    expect(mine[0]!.subject).toMatch(/^Default weekly report: \d+ conversations/);
    expect(mine[0]!.text).toContain("Hours saved");
    expect(mine[0]!.text).toContain("http://localhost:3100/analytics?days=7");

    // Once per day, even if the sweep runs again.
    mails.length = 0;
    await sendDueReports(db, notifier, "http://localhost:3100", new Date("2026-11-02T10:00:00Z"));
    expect(mails.filter((m) => m.to === owner.email)).toHaveLength(0);

    // "Send me a test report" goes to the caller only.
    const test = await call(owner.id, "POST", "/v1/reports/send-test");
    expect(test.json()).toMatchObject({ sent: 1 });
    expect(mails.at(-1)?.to).toBe(owner.email);
    expect((await call(builder.id, "POST", "/v1/reports/send-test")).statusCode).toBe(403);
    await call(owner.id, "PUT", "/v1/workspace/settings", {
      reports: { enabled: false, weekday: 1, hourUtc: 8, extraRecipients: [] },
    });
  });

  it("checks members with custom roles against the role's permissions", async () => {
    const lead = await call(owner.id, "POST", "/v1/roles", {
      name: "Support lead",
      baseRole: "viewer",
      permissions: ["inbox.decide", "flows.comment", "audit.view"],
    });
    expect(lead.statusCode).toBe(201);
    expect(
      (await call(owner.id, "POST", "/v1/roles", { name: "Support lead", baseRole: "viewer", permissions: [] }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call(builder.id, "POST", "/v1/roles", { name: "X", baseRole: "viewer", permissions: [] })).statusCode,
    ).toBe(403);

    await call(owner.id, "PATCH", `/v1/members/${builder.id}`, { customRoleId: lead.json().id });
    const members = (await call(owner.id, "GET", "/v1/members")).json().members;
    expect(members.find((m: { userId: string }) => m.userId === builder.id)).toMatchObject({
      role: "viewer",
      customRole: "Support lead",
    });
    // Granted beyond the base role; denied where the role lacks the permission; base role elsewhere.
    expect((await call(builder.id, "GET", "/v1/audit")).statusCode).toBe(200);
    expect((await call(builder.id, "POST", "/v1/flows", { name: "Nope" })).statusCode).toBe(403);
    expect((await call(builder.id, "GET", "/v1/flows")).statusCode).toBe(200);

    // A builder who can't publish: built-in preset minus one permission.
    const { presets } = (await call(owner.id, "GET", "/v1/roles")).json();
    const noPublish = await call(owner.id, "POST", "/v1/roles", {
      name: "Builder (no publish)",
      baseRole: "builder",
      permissions: presets.builder.filter((p: string) => p !== "flows.publish"),
    });
    await call(owner.id, "PATCH", `/v1/members/${builder.id}`, { customRoleId: noPublish.json().id });
    const created = await call(builder.id, "POST", "/v1/flows", { name: "Draft only" });
    expect(created.statusCode).toBe(201);
    expect((await call(builder.id, "POST", `/v1/flows/${created.json().id}/publish`)).statusCode).toBe(403);

    // Clearing the custom role keeps its base role as the built-in role.
    await call(owner.id, "PATCH", `/v1/members/${builder.id}`, { customRoleId: null });
    const [nodes, edges] = echoFlow("Hi");
    await call(builder.id, "PUT", `/v1/flows/${created.json().id}/draft`, {
      draft: { schemaVersion: 1, id: created.json().id, name: "Draft only", nodes, edges },
    });
    expect((await call(builder.id, "POST", `/v1/flows/${created.json().id}/publish`)).statusCode).toBe(201);
    const roles = (await call(owner.id, "GET", "/v1/roles")).json().roles;
    expect(roles.map((r: { name: string; members: number }) => [r.name, r.members])).toEqual([
      ["Builder (no publish)", 0],
      ["Support lead", 0],
    ]);
    await call(owner.id, "PATCH", `/v1/members/${builder.id}`, { role: "builder" });
  });

  it("maps every protected write route to a permission", () => {
    const routesDir = new URL("../src/routes/", import.meta.url);
    const missing: string[] = [];
    for (const file of readdirSync(routesDir)) {
      const src = readFileSync(new URL(file, routesDir), "utf8");
      const re =
        /app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"([^"]+)",\s*\{\s*preHandler:\s*auth\.requireWorkspace\("(\w+)"\)/g;
      for (const m of src.matchAll(re)) {
        const [, method, path, role] = m;
        const key = `${method!.toUpperCase()} /v1${path}`;
        if (method !== "get" && role !== "viewer" && !ROUTE_PERMISSIONS[key]) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("shares a live document between editors and saves it to the draft", async () => {
    const flowId = await makeFlow("Co-edit", ...echoFlow("Hello"));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const token = (sub: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuer(TOKEN_ISSUER)
        .setAudience(COLLAB_AUDIENCE)
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode(jwtSecret));
    const connect = async (sub: string) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/v1/collab`, flowId, doc, {
        params: { token: await token(sub) },
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        disableBc: true,
      });
      await new Promise<void>((resolve) => provider.once("sync", () => resolve()));
      return { doc, provider, nodes: doc.getMap<{ id: string; label: string }>("nodes") };
    };

    const a = await connect(owner.id);
    const b = await connect(builder.id);
    expect([...a.nodes.keys()].sort()).toEqual(["end", "start"]);

    // An edit in one editor appears in the other, and is saved to the draft shortly after.
    a.nodes.set("end", { ...a.nodes.get("end")!, label: "Goodbye" });
    await expect.poll(() => b.nodes.get("end")?.label).toBe("Goodbye");
    await expect
      .poll(async () => {
        const [row] = await db.select({ draft: flows.draftJson }).from(flows).where(eq(flows.id, flowId));
        return row?.draft.nodes.find((n) => n.id === "end")?.label;
      })
      .toBe("Goodbye");

    // Reviewers can watch but their edits are ignored.
    await call(owner.id, "PATCH", `/v1/members/${builder.id}`, { role: "reviewer" });
    b.provider.destroy();
    const watcher = await connect(builder.id);
    watcher.nodes.set("end", { ...watcher.nodes.get("end")!, label: "Hijacked" });
    await new Promise((r) => setTimeout(r, 300));
    expect(a.nodes.get("end")?.label).toBe("Goodbye");
    watcher.provider.destroy();
    await call(owner.id, "PATCH", `/v1/members/${builder.id}`, { role: "builder" });

    // A bad token is refused.
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/collab/${flowId}?token=nope`);
      ws.on("close", (code) => resolve(code));
    });
    expect(closed).toBe(4401);
    a.provider.destroy();
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
