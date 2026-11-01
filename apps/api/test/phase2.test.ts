import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { eq, like } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, orgs, users } from "@agentflow/db";
import type { FlowInput } from "@agentflow/flow-schema";
import { startMockLlm } from "@agentflow/llm-gateway/mock-server";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "../src/app";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";
import { loadRootEnv } from "../src/config";
import { chunkText, htmlToText } from "../src/routes/knowledge";

// End-to-end Phase 2 features over a real Postgres and the mock model. Skipped without DATABASE_URL.
loadRootEnv();
const url = process.env.DATABASE_URL;
const jwtSecret = "test-secret-at-least-16-chars";
const LLM_PORT = 4931;
const model = { provider: "openai_compatible" as const, name: "mock-1" };
const at = { x: 0, y: 0 };

type Event = {
  type: string;
  runId?: string;
  content?: string;
  nodeId?: string;
  citations?: unknown[];
  [k: string]: unknown;
};
const parseSse = (body: string): Event[] =>
  body
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)));

describe("chunking and HTML extraction", () => {
  it("splits long text into overlapping passages", () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i} explains shipping rule number ${i} in detail.`,
    ).join("\n\n");
    const parts = chunkText(text, 300, 50);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.length <= 400)).toBe(true);
  });

  it("extracts readable text from HTML", () => {
    const { title, text } = htmlToText(
      "<html><head><title>Help</title><script>x()</script></head><body><nav>menu</nav><p>Returns &amp; refunds</p></body></html>",
    );
    expect(title).toBe("Help");
    expect(text).toBe("Returns & refunds");
  });
});

describe.skipIf(!url)("Phase 2 API", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const run = randomBytes(4).toString("hex");
  const owner = { id: `usr_p2o_${run}`, email: `p2o-${run}@test.local` };
  const builder = { id: `usr_p2b_${run}`, email: `p2b-${run}@test.local` };
  const reviewer = { id: `usr_p2r_${run}`, email: `p2r-${run}@test.local` };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let llm: Server;
  let workspaceId = "";
  let orgId = "";

  const call = async (as: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: object) => {
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

  /** Creates a flow with the given nodes/edges as its draft. */
  async function makeFlow(name: string, nodes: FlowInput["nodes"], edges: FlowInput["edges"]) {
    const { id } = (await call(owner.id, "POST", "/v1/flows", { name })).json();
    const res = await call(owner.id, "PUT", `/v1/flows/${id}/draft`, {
      draft: { schemaVersion: 1, id, name, nodes, edges },
    });
    expect(res.json().validation.errors).toEqual([]);
    return id as string;
  }

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
    await db.insert(users).values([owner, builder, reviewer]);
    const ws = (await call(owner.id, "POST", "/v1/orgs", { orgName: "Phase2" })).json();
    workspaceId = ws.id;
    orgId = ws.orgId;
    await call(owner.id, "POST", "/v1/invites", { email: builder.email, role: "builder" });
    await call(owner.id, "POST", "/v1/invites", { email: reviewer.email, role: "reviewer" });
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

  it("answers from knowledge sources with citations", async () => {
    const added = await call(owner.id, "POST", "/v1/knowledge", {
      type: "text",
      name: "Returns policy",
      content:
        "Returns are accepted within 30 days of delivery.\n\nRefunds are issued to the original payment method within 5 business days.",
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().chunks).toBeGreaterThan(0);
    const search = (
      await call(owner.id, "POST", "/v1/knowledge/search", { query: "How long do refunds take?" })
    ).json();
    expect(search.results[0].text).toContain("5 business days");
    expect((await call(owner.id, "GET", "/v1/knowledge")).json().sources).toHaveLength(1);

    const flowId = await makeFlow(
      "Help",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "kb", type: "knowledge", label: "Search", position: at, config: {} },
        { id: "done", type: "end", label: "Done", position: at, config: { message: "Found {{kb.found}} passage(s)" } },
      ],
      [
        { id: "1", source: "start", target: "kb" },
        { id: "2", source: "kb", target: "done" },
      ],
    );
    const events = parseSse(
      (await call(owner.id, "POST", `/v1/flows/${flowId}/test-runs`, { message: "refund timing?" })).body,
    );
    expect(events.find((e) => e.type === "message")).toMatchObject({
      content: "Found 1 passage(s)",
      citations: [{ n: 1, title: "Returns policy" }],
    });
  });

  it("pauses for approval, shows it in the inbox, and resumes on the decision", async () => {
    const flowId = await makeFlow(
      "Refunds",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "approve",
          type: "approval",
          label: "Approve",
          position: at,
          config: { message: "Refund: {{trigger.message}}" },
        },
        {
          id: "yes",
          type: "end",
          label: "Yes",
          position: at,
          config: { message: "Your refund is approved.", outcome: "resolved" },
        },
        {
          id: "no",
          type: "end",
          label: "No",
          position: at,
          config: { message: "Sorry, no refund.", outcome: "failed" },
        },
      ],
      [
        { id: "1", source: "start", target: "approve" },
        { id: "2", source: "approve", sourceHandle: "approved", target: "yes" },
        { id: "3", source: "approve", sourceHandle: "rejected", target: "no" },
        { id: "4", source: "approve", sourceHandle: "timeout", target: "no" },
      ],
    );
    await call(owner.id, "POST", `/v1/flows/${flowId}/publish`);
    const { widgetKey } = (await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json();
    const start = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      payload: { message: "order 1042 broke" },
    });
    const session = JSON.parse(
      start.body
        .split("\n\n")
        .find((b) => b.startsWith("event: session"))!
        .split("data: ")[1]!,
    );
    expect(parseSse(start.body).at(-1)).toEqual({ type: "paused", reason: "approval" });

    const blocked = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions/${session.runId}/messages`,
      payload: { message: "hello?", sessionToken: session.sessionToken },
    });
    expect(blocked.statusCode).toBe(423);

    const inbox = (await call(reviewer.id, "GET", "/v1/inbox")).json();
    const item = inbox.approvals.find((a: { runId: string }) => a.runId === session.runId);
    expect(item).toMatchObject({ message: "Refund: order 1042 broke", canDecide: true });

    const decided = (
      await call(reviewer.id, "POST", `/v1/approvals/${item.id}/decide`, { decision: "approve" })
    ).json();
    expect(decided).toMatchObject({ decision: "approved", runStatus: "waiting_input", error: null });
    expect(
      (await call(reviewer.id, "POST", `/v1/approvals/${item.id}/decide`, { decision: "reject" })).statusCode,
    ).toBe(409);

    const poll = await app.inject({
      method: "GET",
      url: `/v1/widget/${widgetKey}/sessions/${session.runId}?sessionToken=${session.sessionToken}`,
    });
    expect(poll.json().messages.at(-1)).toEqual({ role: "assistant", content: "Your refund is approved." });

    const fb = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions/${session.runId}/feedback`,
      payload: { sessionToken: session.sessionToken, rating: 5 },
    });
    expect(fb.statusCode).toBe(204);
  });

  it("hands conversations to people", async () => {
    const flowId = await makeFlow(
      "Escalate",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "human", type: "handoff", label: "Human", position: at, config: { queue: "billing" } },
      ],
      [{ id: "1", source: "start", target: "human" }],
    );
    const events = parseSse(
      (await call(owner.id, "POST", `/v1/flows/${flowId}/test-runs`, { message: "charged twice" })).body,
    );
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "escalated" });
    const inbox = (await call(owner.id, "GET", "/v1/inbox")).json();
    const handoff = inbox.handoffs.find((h: { queue: string }) => h.queue === "billing");
    expect(handoff.summary).toBe("- charged twice");
    expect((await call(owner.id, "POST", `/v1/handoffs/${handoff.id}/close`)).json()).toMatchObject({
      status: "closed",
    });
  });

  it("runs evals in a sandbox and enforces the publish gate", async () => {
    const flowId = await makeFlow(
      "Triage",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "triage",
          type: "agent",
          label: "Triage",
          position: at,
          config: {
            model,
            systemPrompt: "Classify",
            userPrompt: "{{trigger.message}}",
            outputSchema: {
              type: "object",
              properties: { intent: { type: "string", enum: ["refund", "other"] } },
              required: ["intent"],
            },
          },
        },
        {
          id: "route",
          type: "decision",
          label: "Route",
          position: at,
          config: {
            outcomes: [{ id: "refund", condition: 'triage.output.intent == "refund"' }],
            defaultOutcome: "other",
          },
        },
        {
          id: "r",
          type: "end",
          label: "R",
          position: at,
          config: { message: "Refund team will help", outcome: "escalated" },
        },
        { id: "o", type: "end", label: "O", position: at, config: { message: "Happy to help", outcome: "resolved" } },
      ],
      [
        { id: "1", source: "start", target: "triage" },
        { id: "2", source: "triage", target: "route" },
        { id: "3", source: "route", sourceHandle: "refund", target: "r" },
        { id: "4", source: "route", sourceHandle: "other", target: "o" },
      ],
    );
    expect(
      (await call(owner.id, "PUT", `/v1/flows/${flowId}/settings`, { publishGate: { enabled: true, minPassRate: 1 } }))
        .statusCode,
    ).toBe(200);
    const blocked = await call(owner.id, "POST", `/v1/flows/${flowId}/publish`);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toMatch(/Run the evals/);

    const ds = (await call(owner.id, "POST", `/v1/flows/${flowId}/evals`, { name: "Regression" })).json();
    await call(owner.id, "POST", `/v1/evals/${ds.id}/cases`, {
      input: "I want a refund",
      expected: { outcome: "escalated", contains: "refund" },
    });
    const wrong = (
      await call(owner.id, "POST", `/v1/evals/${ds.id}/cases`, { input: "hello", expected: { outcome: "escalated" } })
    ).json();

    const first = (await call(owner.id, "POST", `/v1/evals/${ds.id}/run`, {})).json();
    expect(first).toMatchObject({ passed: 1, total: 2, passRate: 0.5 });
    expect((await call(owner.id, "POST", `/v1/flows/${flowId}/publish`)).json().error).toMatch(
      /below the required 100%/,
    );

    await call(owner.id, "DELETE", `/v1/evals/${ds.id}/cases/${wrong.id}`);
    expect((await call(owner.id, "POST", `/v1/evals/${ds.id}/run`, {})).json()).toMatchObject({ passed: 1, total: 1 });
    expect((await call(owner.id, "POST", `/v1/flows/${flowId}/publish`)).statusCode).toBe(201);

    const listed = (await call(owner.id, "GET", `/v1/flows/${flowId}/evals`)).json();
    expect(listed.datasets[0].runs).toHaveLength(2);
  });

  it("requires a review before changes go live, when enabled", async () => {
    const flowId = await makeFlow(
      "Reviewed",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "done", type: "end", label: "Done", position: at, config: { message: "hi" } },
      ],
      [{ id: "1", source: "start", target: "done" }],
    );
    await call(owner.id, "PUT", `/v1/flows/${flowId}/settings`, { requireReview: true });
    const published = (await call(builder.id, "POST", `/v1/flows/${flowId}/publish`)).json();
    expect(published).toMatchObject({ status: "staging" });
    expect((await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json().liveVersionId).toBeNull();
    expect(
      (await call(builder.id, "POST", `/v1/reviews/${published.reviewId}/decide`, { decision: "approve" })).statusCode,
    ).toBe(403);
    expect(
      (await call(reviewer.id, "POST", `/v1/reviews/${published.reviewId}/decide`, { decision: "approve" })).statusCode,
    ).toBe(200);
    expect((await call(owner.id, "GET", `/v1/flows/${flowId}/widget`)).json().liveVersionId).toBe(published.id);
  });

  it("reports ROI analytics and enforces budgets", async () => {
    await call(owner.id, "PUT", "/v1/workspace/settings", {
      roi: { costPerConversation: 10, minutesPerConversation: 6 },
    });
    const a = (await call(owner.id, "GET", "/v1/analytics?days=7")).json();
    expect(a.totals.resolved).toBeGreaterThanOrEqual(1); // the approved refund
    expect(a.totals.escalated).toBe(0); // the handoff was a test-console run, which analytics excludes
    expect(a.totals.csat).toBe(5);
    expect(a.roi.grossSavingsUsd).toBe((a.totals.resolved + a.totals.converted) * 10);
    expect(a.roi.baselineIsDefault).toBe(false);

    await call(owner.id, "PUT", "/v1/workspace/settings", { budget: { monthlyTokens: 1 } });
    const flowId = await makeFlow(
      "Chatty",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "a",
          type: "agent",
          label: "A",
          position: at,
          config: { model, systemPrompt: "", userPrompt: "{{trigger.message}}" },
        },
        { id: "done", type: "end", label: "Done", position: at, config: { message: "{{a.text}}" } },
      ],
      [
        { id: "1", source: "start", target: "a" },
        { id: "2", source: "a", target: "done" },
      ],
    );
    // Test runs count toward usage; the earlier eval runs (sandbox) do not.
    const settings = (await call(owner.id, "GET", "/v1/workspace/settings")).json();
    expect(settings.usage.tokens).toBeGreaterThanOrEqual(0);
    await call(owner.id, "POST", `/v1/flows/${flowId}/test-runs`, { message: "first" });
    const events = parseSse(
      (await call(owner.id, "POST", `/v1/flows/${flowId}/test-runs`, { message: "second" })).body,
    );
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("monthly AI budget") });
    await call(owner.id, "PUT", "/v1/workspace/settings", { budget: null });
  });
});
