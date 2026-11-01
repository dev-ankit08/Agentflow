import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { eq, like } from "drizzle-orm";
import { SignJWT, createLocalJWKSet, exportJWK, importPKCS8, importSPKI } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, orgs, runs, users } from "@agentflow/db";
import type { FlowInput } from "@agentflow/flow-schema";
import { startMockLlm } from "@agentflow/llm-gateway/mock-server";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "../src/app";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";
import { formEncode, verifyStripeSignature } from "../src/billing";
import { loadRootEnv } from "../src/config";

// Slack, Teams, WhatsApp and Stripe against a local fake of each platform. Skipped without DATABASE_URL.
loadRootEnv();
const url = process.env.DATABASE_URL;
const jwtSecret = "test-secret-at-least-16-chars";
const FAKE_PORT = 4951;
const LLM_PORT = 4952;
const FAKE = `http://localhost:${FAKE_PORT}`;
const at = { x: 0, y: 0 };

type Call = { path: string; headers: Record<string, string | string[] | undefined>; body: string };

describe("Stripe helpers", () => {
  it("verifies Stripe signatures and form-encodes nested params", () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_x").update(`${t}.{"a":1}`).digest("hex");
    expect(verifyStripeSignature("whsec_x", `t=${t},v1=${sig}`, '{"a":1}')).toBe(true);
    expect(verifyStripeSignature("whsec_x", `t=${t},v1=${sig}`, '{"a":2}')).toBe(false);
    expect(verifyStripeSignature("whsec_x", `t=${t - 1000},v1=${sig}`, '{"a":1}')).toBe(false);
    expect(formEncode({ line_items: { 0: { price: "p_1", quantity: 1 } }, metadata: { org_id: "o" } })).toEqual([
      "line_items%5B0%5D%5Bprice%5D=p_1",
      "line_items%5B0%5D%5Bquantity%5D=1",
      "metadata%5Borg_id%5D=o",
    ]);
  });
});

describe.skipIf(!url)("Integrations", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const run = randomBytes(4).toString("hex");
  const owner = { id: `usr_int_${run}`, email: `int-${run}@test.local` };
  const calls: Call[] = [];
  let fake: Server;
  let llm: Server;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let workspaceId = "";
  let orgId = "";
  let flowId = "";
  let approvalFlowId = "";

  // Bot Framework signs tokens with Microsoft's keys; the test signs with its own key and serves it as the JWKS.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let teamsJwks: ReturnType<typeof createLocalJWKSet>;

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

  async function publishFlow(name: string, nodes: FlowInput["nodes"], edges: FlowInput["edges"]) {
    const { id } = (await call("POST", "/v1/flows", { name })).json();
    await call("PUT", `/v1/flows/${id}/draft`, { draft: { schemaVersion: 1, id, name, nodes, edges } });
    expect((await call("POST", `/v1/flows/${id}/publish`)).statusCode).toBe(201);
    return id as string;
  }

  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      calls.push({ path: req.url ?? "", headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      const p = req.url ?? "";
      if (p === "/slack/chat.postMessage") return res.end(JSON.stringify({ ok: true }));
      if (p === "/teams/token") return res.end(JSON.stringify({ access_token: "teams-token", expires_in: 3600 }));
      if (p === "/stripe/customers") return res.end(JSON.stringify({ id: "cus_123" }));
      if (p === "/stripe/checkout/sessions")
        return res.end(JSON.stringify({ url: "https://checkout.stripe.test/c/1" }));
      if (p === "/stripe/billing_portal/sessions")
        return res.end(JSON.stringify({ url: "https://billing.stripe.test/p/1" }));
      res.end("{}");
    });
    await new Promise<void>((r) => fake.listen(FAKE_PORT, r));
    llm = await startMockLlm(LLM_PORT, { delayMs: 0 });

    const pub = await exportJWK(await importSPKI(publicKey, "RS256", { extractable: true }));
    teamsJwks = createLocalJWKSet({ keys: [{ ...pub, kid: "test", alg: "RS256", use: "sig" }] });

    app = await buildApp({
      db,
      secrets: createSecretStore(randomBytes(32).toString("base64")),
      jwtSecret,
      corsOrigin: "http://localhost:3100",
      allowPrivateHttp: true,
      sweepIntervalMs: 0,
      syncChannels: true,
      publicApiUrl: "https://api.example.test",
      channelEndpoints: {
        slackApi: `${FAKE}/slack`,
        whatsappGraph: `${FAKE}/graph`,
        teamsToken: () => `${FAKE}/teams/token`,
        teamsJwks,
        teamsIssuer: "https://api.botframework.com",
      },
      stripe: {
        secretKey: "sk_test_x",
        webhookSecret: "whsec_test",
        prices: { pro: "price_pro", business: "price_business" },
        appUrl: "http://localhost:3100",
        apiBase: `${FAKE}/stripe`,
      },
    });
    await db.insert(users).values(owner);
    const ws = (await call("POST", "/v1/orgs", { orgName: "Integrations" })).json();
    workspaceId = ws.id;
    orgId = ws.orgId;
    await call("POST", "/v1/provider-keys", {
      provider: "openai_compatible",
      label: "Mock",
      secret: "mock",
      baseUrl: `http://localhost:${LLM_PORT}/v1`,
    });

    flowId = await publishFlow(
      "Echo",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "done",
          type: "end",
          label: "Done",
          position: at,
          config: { message: "You said: {{trigger.message}} (turn {{conversation.turn}})" },
        },
      ],
      [{ id: "1", source: "start", target: "done" }],
    );
    approvalFlowId = await publishFlow(
      "Refunds",
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "approve", type: "approval", label: "Approve", position: at, config: { message: "Refund?" } },
        { id: "yes", type: "end", label: "Yes", position: at, config: { message: "Refund approved!" } },
        { id: "no", type: "end", label: "No", position: at, config: { message: "Refund declined." } },
      ],
      [
        { id: "1", source: "start", target: "approve" },
        { id: "2", source: "approve", sourceHandle: "approved", target: "yes" },
        { id: "3", source: "approve", sourceHandle: "rejected", target: "no" },
        { id: "4", source: "approve", sourceHandle: "timeout", target: "no" },
      ],
    );
  });

  afterAll(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(like(users.id, `%_${run}`));
    await app.close();
    await close();
    await Promise.all([fake, llm].map((s) => new Promise((r) => s.close(r))));
  });

  const slackHeaders = (secret: string, body: string, ts = Math.floor(Date.now() / 1000)) => ({
    "content-type": "application/json",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
  });

  it("Slack: verifies signatures, answers URL verification and replies in the thread", async () => {
    const created = await call("POST", "/v1/channels", {
      type: "slack",
      flowId,
      name: "Support Slack",
      secrets: { botToken: "xoxb-test", signingSecret: "slack-secret" },
    });
    expect(created.statusCode).toBe(201);
    const ch = created.json();
    expect(ch.webhookUrl).toBe(`https://api.example.test/v1/channels/slack/${ch.id}/events`);
    expect(JSON.stringify(created.json())).not.toContain("xoxb-test");
    const path = `/v1/channels/slack/${ch.id}/events`;

    const challenge = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const ok = await app.inject({
      method: "POST",
      url: path,
      headers: slackHeaders("slack-secret", challenge),
      payload: challenge,
    });
    expect(ok.json()).toEqual({ challenge: "abc123" });
    const forged = await app.inject({
      method: "POST",
      url: path,
      headers: slackHeaders("wrong", challenge),
      payload: challenge,
    });
    expect(forged.statusCode).toBe(401);

    const event = (text: string, ts: string, thread_ts?: string) =>
      JSON.stringify({
        type: "event_callback",
        event: { type: "app_mention", text: `<@U0BOT> ${text}`, user: "U123", channel: "C1", ts, thread_ts },
      });
    calls.length = 0;
    const first = event("hello", "111.1");
    await app.inject({ method: "POST", url: path, headers: slackHeaders("slack-secret", first), payload: first });
    const second = event("again", "111.2", "111.1");
    await app.inject({ method: "POST", url: path, headers: slackHeaders("slack-secret", second), payload: second });
    const posts = calls
      .filter((c) => c.path === "/slack/chat.postMessage")
      .map((c) => ({ auth: c.headers.authorization, ...JSON.parse(c.body) }));
    expect(posts).toEqual([
      { auth: "Bearer xoxb-test", channel: "C1", thread_ts: "111.1", text: "You said: hello (turn 1)" },
      { auth: "Bearer xoxb-test", channel: "C1", thread_ts: "111.1", text: "You said: again (turn 2)" },
    ]);
  });

  const whatsappHeaders = (secret: string, body: string) => ({
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  });
  const waMessage = (from: string, text: string) =>
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: "Jane" } }],
                messages: [{ from, type: "text", text: { body: text } }],
              },
            },
          ],
        },
      ],
    });

  it("WhatsApp: completes Meta's verification and replies to messages", async () => {
    const ch = (
      await call("POST", "/v1/channels", {
        type: "whatsapp",
        flowId,
        name: "WhatsApp",
        config: { phoneNumberId: "PN1" },
        secrets: { accessToken: "EAAG-test", appSecret: "app-secret", verifyToken: "verify-me-123" },
      })
    ).json();
    const path = `/v1/channels/whatsapp/${ch.id}/webhook`;
    const verified = await app.inject({
      method: "GET",
      url: `${path}?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=987`,
    });
    expect(verified.body).toBe("987");
    expect(
      (await app.inject({ method: "GET", url: `${path}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1` }))
        .statusCode,
    ).toBe(403);

    calls.length = 0;
    const body = waMessage("15551234567", "hi there");
    expect(
      (await app.inject({ method: "POST", url: path, headers: whatsappHeaders("app-secret", body), payload: body }))
        .statusCode,
    ).toBe(200);
    const sent = calls.find((c) => c.path === "/graph/PN1/messages")!;
    expect(sent.headers.authorization).toBe("Bearer EAAG-test");
    expect(JSON.parse(sent.body)).toEqual({
      messaging_product: "whatsapp",
      to: "15551234567",
      type: "text",
      text: { body: "You said: hi there (turn 1)" },
    });
    expect(
      (await app.inject({ method: "POST", url: path, headers: whatsappHeaders("bad", body), payload: body }))
        .statusCode,
    ).toBe(401);
  });

  it("WhatsApp: delivers the reply after an Inbox approval", async () => {
    const ch = (
      await call("POST", "/v1/channels", {
        type: "whatsapp",
        flowId: approvalFlowId,
        name: "WhatsApp refunds",
        config: { phoneNumberId: "PN2" },
        secrets: { accessToken: "EAAG-2", appSecret: "app-secret-2", verifyToken: "verify-me-456" },
      })
    ).json();
    const path = `/v1/channels/whatsapp/${ch.id}/webhook`;
    calls.length = 0;
    const body = waMessage("15559990000", "refund please");
    await app.inject({ method: "POST", url: path, headers: whatsappHeaders("app-secret-2", body), payload: body });
    const texts = () => calls.filter((c) => c.path === "/graph/PN2/messages").map((c) => JSON.parse(c.body).text.body);
    expect(texts()).toEqual(["Thanks — a team member is reviewing this and I'll reply here shortly."]);

    const inbox = (await call("GET", "/v1/inbox")).json();
    await call("POST", `/v1/approvals/${inbox.approvals[0].id}/decide`, { decision: "approve" });
    expect(texts().at(-1)).toBe("Refund approved!");
  });

  it("Teams: accepts only Bot Framework-signed activities and replies through the connector", async () => {
    const ch = (
      await call("POST", "/v1/channels", {
        type: "teams",
        flowId,
        name: "Teams",
        config: { appId: "app-123" },
        secrets: { appPassword: "pw" },
      })
    ).json();
    const serviceUrl = `${FAKE}/teams/service/`;
    const token = (aud: string) =>
      importPKCS8(privateKey, "RS256").then((k) =>
        new SignJWT({ serviceurl: serviceUrl })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer("https://api.botframework.com")
          .setAudience(aud)
          .setExpirationTime("5m")
          .sign(k),
      );
    const activity = {
      type: "message",
      id: "act-1",
      text: "<at>Bot</at> hello teams",
      serviceUrl,
      conversation: { id: "conv-9" },
      from: { id: "u1", name: "Sam" },
    };
    const path = `/v1/channels/teams/${ch.id}/messages`;

    expect(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${await token("other-app")}` },
          payload: activity,
        })
      ).statusCode,
    ).toBe(401);
    calls.length = 0;
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${await token("app-123")}` },
      payload: activity,
    });
    expect(res.statusCode).toBe(200);
    expect(calls.find((c) => c.path === "/teams/token")!.body).toContain("client_id=app-123");
    const reply = calls.find((c) => c.path.startsWith("/teams/service/"))!;
    expect(reply.path).toBe("/teams/service/v3/conversations/conv-9/activities/act-1");
    expect(reply.headers.authorization).toBe("Bearer teams-token");
    expect(JSON.parse(reply.body)).toMatchObject({
      type: "message",
      text: "You said: hello teams (turn 1)",
      replyToId: "act-1",
    });
  });

  it("Stripe: Checkout, portal and signed webhooks keep the plan in sync", async () => {
    const summary = (await call("GET", "/v1/billing")).json();
    expect(summary).toMatchObject({ configured: true, plan: "free", usage: { limit: 100 } });

    expect((await call("POST", "/v1/billing/checkout", { plan: "pro" })).json()).toEqual({
      url: "https://checkout.stripe.test/c/1",
    });
    const checkout = calls.find((c) => c.path === "/stripe/checkout/sessions")!;
    expect(checkout.headers.authorization).toBe("Bearer sk_test_x");
    expect(new URLSearchParams(checkout.body).get("line_items[0][price]")).toBe("price_pro");
    expect((await call("POST", "/v1/billing/portal")).json()).toEqual({ url: "https://billing.stripe.test/p/1" });

    const send = async (event: object) => {
      const raw = JSON.stringify(event);
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", "whsec_test").update(`${t}.${raw}`).digest("hex");
      return app.inject({
        method: "POST",
        url: "/v1/billing/webhook",
        headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
        payload: raw,
      });
    };
    await send({
      type: "checkout.session.completed",
      data: { object: { metadata: { org_id: orgId, plan: "pro" }, customer: "cus_123", subscription: "sub_1" } },
    });
    expect((await call("GET", "/v1/billing")).json()).toMatchObject({ plan: "pro", usage: { limit: 2000 } });
    await send({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_1",
          status: "canceled",
          metadata: { org_id: orgId },
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    });
    expect((await call("GET", "/v1/billing")).json().plan).toBe("free");

    const forged = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=bad" },
      payload: "{}",
    });
    expect(forged.statusCode).toBe(400);
  });

  it("enforces the plan's monthly conversation limit when billing is on", async () => {
    const [{ id: versionId } = { id: "" }] = (await call("GET", `/v1/flows/${flowId}/versions`)).json().versions;
    await db.insert(runs).values(
      Array.from({ length: 100 }, () => ({
        workspaceId,
        flowId,
        flowVersionId: versionId,
        triggerType: "chat",
        status: "completed" as const,
      })),
    );
    const { widgetKey } = (await call("GET", `/v1/flows/${flowId}/widget`)).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/widget/${widgetKey}/sessions`,
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(402);
  });
});
