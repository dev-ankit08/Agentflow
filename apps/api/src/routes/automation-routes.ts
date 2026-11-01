import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { feedback, flowComments, flowVersions, flows, newId, runs } from "@agentflow/db";
import { Flow, nextCronRun, parseCron } from "@agentflow/flow-schema";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { automationOf, type FlowAutomation } from "../automation";
import { makeLive } from "./publish";

const WebhookBody = z.object({
  signed: z.boolean().default(true),
  signature: z.enum(["agentflow", "hubspot"]).default("agentflow"),
  secret: z.string().trim().min(8).max(500).optional(),
  batch: z.boolean().default(false),
});
const AbTestBody = z.object({ versionId: z.string().min(1), percent: z.number().int().min(1).max(90) });
const CommentBody = z.object({ nodeId: z.string().min(1).max(100), body: z.string().trim().min(1).max(2000) });

/** Who has each flow open in the builder, refreshed by a heartbeat (in memory for the prototype). */
const presence = new Map<string, Map<string, { name: string; at: number; nodeId?: string }>>();
const PRESENCE_TTL = 30_000;

/** Triggers (H8), A/B tests between versions, and collaboration (H10): presence and node comments. */
export async function automationRoutes(app: FastifyInstance, { db, auth, secrets, config }: Deps) {
  const findFlow = async (workspaceId: string, id: string) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId)));
    if (!flow) throw new HttpError(404, "Flow not found");
    return flow;
  };
  const saveAutomation = (flow: typeof flows.$inferSelect, patch: Partial<FlowAutomation>) =>
    db
      .update(flows)
      .set({ settings: { ...flow.settings, ...patch } })
      .where(eq(flows.id, flow.id));

  // --- Triggers ------------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/flows/:id/triggers",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const { webhook, emailHook, scheduleState } = automationOf(flow.settings);
      let schedule: { cron: string; live: boolean; nextRun: string | null; lastRunAt: string | null } | null = null;
      const live = flow.liveVersionId
        ? (
            await db
              .select({ json: flowVersions.json })
              .from(flowVersions)
              .where(eq(flowVersions.id, flow.liveVersionId))
          )[0]
        : undefined;
      const liveCron = live?.json.triggers?.find((t) => t.type === "schedule")?.config?.cron;
      if (typeof liveCron === "string") {
        let nextRun: string | null = null;
        try {
          nextRun = nextCronRun(parseCron(liveCron), new Date())?.toISOString() ?? null;
        } catch {
          /* invalid schedules never publish */
        }
        schedule = { cron: liveCron, live: true, nextRun, lastRunAt: scheduleState?.lastRunAt ?? null };
      }
      return {
        webhook: webhook
          ? {
              url: `${config.publicApiUrl}/v1/hooks/${webhook.key}`,
              fileUrl: `${config.publicApiUrl}/v1/hooks/${webhook.key}/file`,
              signed: Boolean(webhook.secretEnc),
              signature: webhook.signature ?? "agentflow",
              batch: Boolean(webhook.batch),
            }
          : null,
        email: emailHook ? { url: `${config.publicApiUrl}/v1/inbound/email/${emailHook.key}` } : null,
        schedule,
      };
    },
  );

  /**
   * Creates (or rotates) the flow's webhook address. AgentFlow-signed hooks get a new signing secret, returned once;
   * HubSpot hooks are verified with the HubSpot app's client secret, which the caller provides.
   */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/webhook",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const body = WebhookBody.parse(req.body ?? {});
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const key = newId("hk");
      let secret: string | null = null;
      let secretEnc: string | undefined;
      if (body.signature === "hubspot") {
        if (!body.secret) throw new HttpError(400, "Paste your HubSpot app's client secret to verify its requests");
        secretEnc = secrets.encrypt(body.secret);
      } else if (body.signed) {
        secret = randomBytes(32).toString("base64url");
        secretEnc = secrets.encrypt(secret);
      }
      await saveAutomation(flow, {
        webhook: { key, signature: body.signature, batch: body.batch, ...(secretEnc && { secretEnc }) },
      });
      return { url: `${config.publicApiUrl}/v1/hooks/${key}`, secret };
    },
  );

  /** Turns batch mode (one run per item of an array or CSV row) on or off without changing the address. */
  app.patch<{ Params: { id: string } }>(
    "/flows/:id/webhook",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const { batch } = z.object({ batch: z.boolean() }).parse(req.body);
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const webhook = automationOf(flow.settings).webhook;
      if (!webhook) throw new HttpError(404, "This flow has no webhook");
      await saveAutomation(flow, { webhook: { ...webhook, batch } });
      return { batch };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/flows/:id/webhook",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      await saveAutomation(flow, { webhook: undefined });
      return reply.code(204).send();
    },
  );

  /** Inbound email address: point your email provider's inbound webhook (Postmark, Mailgun, …) at this URL. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/email-hook",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const key = newId("em");
      await saveAutomation(flow, { emailHook: { key } });
      return { url: `${config.publicApiUrl}/v1/inbound/email/${key}` };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/flows/:id/email-hook",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      await saveAutomation(flow, { emailHook: undefined });
      return reply.code(204).send();
    },
  );

  // --- A/B tests -----------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/flows/:id/ab-test",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const ab = automationOf(flow.settings).abTest;
      if (!ab || !flow.liveVersionId) return { abTest: null, stats: [] };
      const ids = [flow.liveVersionId, ab.versionId];
      const outcome = sql<string | null>`${runs.state}->>'outcome'`;
      const stats = await db
        .select({
          versionId: runs.flowVersionId,
          version: flowVersions.version,
          conversations: sql<number>`count(*)::int`,
          resolved: sql<number>`count(*) filter (where ${outcome} in ('resolved','converted'))::int`,
          escalated: sql<number>`count(*) filter (where ${outcome} = 'escalated' or ${runs.status} = 'handed_off')::int`,
          failed: sql<number>`count(*) filter (where ${outcome} = 'failed' or ${runs.status} = 'failed')::int`,
          avgCostUsd: sql<number>`coalesce(avg(${runs.costUsd}), 0)::float`,
          thumbsUp: sql<number>`count(${feedback.rating}) filter (where ${feedback.rating} = 5)::int`,
          rated: sql<number>`count(${feedback.rating})::int`,
        })
        .from(runs)
        .innerJoin(flowVersions, eq(flowVersions.id, runs.flowVersionId))
        .leftJoin(feedback, eq(feedback.runId, runs.id))
        .where(
          and(eq(runs.flowId, flow.id), inArray(runs.flowVersionId, ids), gte(runs.startedAt, new Date(ab.startedAt))),
        )
        .groupBy(runs.flowVersionId, flowVersions.version);
      const versions = await db
        .select({ id: flowVersions.id, version: flowVersions.version })
        .from(flowVersions)
        .where(inArray(flowVersions.id, ids));
      return {
        abTest: ab,
        stats: ids.map((id) => {
          const row = stats.find((s) => s.versionId === id);
          return {
            versionId: id,
            version: versions.find((v) => v.id === id)?.version ?? null,
            role: id === ab.versionId ? "challenger" : "live",
            conversations: row?.conversations ?? 0,
            resolved: row?.resolved ?? 0,
            escalated: row?.escalated ?? 0,
            failed: row?.failed ?? 0,
            avgCostUsd: row?.avgCostUsd ?? 0,
            satisfaction: row?.rated ? row.thumbsUp / row.rated : null,
          };
        }),
      };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/flows/:id/ab-test",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const body = AbTestBody.parse(req.body);
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      if (!flow.liveVersionId) throw new HttpError(409, "Publish the flow before starting an A/B test");
      if (body.versionId === flow.liveVersionId) throw new HttpError(400, "Pick a version other than the live one");
      const [version] = await db
        .select({ id: flowVersions.id })
        .from(flowVersions)
        .where(and(eq(flowVersions.id, body.versionId), eq(flowVersions.flowId, flow.id)));
      if (!version) throw new HttpError(404, "Version not found");
      const abTest = { ...body, startedAt: new Date().toISOString() };
      await saveAutomation(flow, { abTest });
      return { abTest };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/flows/:id/ab-test",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      await saveAutomation(flow, { abTest: undefined });
      return reply.code(204).send();
    },
  );

  /** Makes the challenger the live version and ends the test. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/ab-test/promote",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const ab = automationOf(flow.settings).abTest;
      if (!ab) throw new HttpError(409, "No A/B test is running");
      await db.transaction(async (tx) => {
        await makeLive(tx, flow.id, ab.versionId);
        await tx
          .update(flows)
          .set({ settings: { ...flow.settings, abTest: undefined } })
          .where(eq(flows.id, flow.id));
      });
      return { liveVersionId: ab.versionId };
    },
  );

  // --- Collaboration -------------------------------------------------------------------------

  /** Heartbeat from an open editor; returns the other people editing this flow right now. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/presence",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const { nodeId } = z.object({ nodeId: z.string().max(100).optional() }).parse(req.body ?? {});
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const user = currentUser(req);
      const now = Date.now();
      const here = presence.get(flow.id) ?? new Map();
      presence.set(flow.id, here);
      here.set(user.id, { name: user.name ?? user.email ?? "Someone", at: now, nodeId });
      for (const [id, p] of here) if (now - p.at > PRESENCE_TTL) here.delete(id);
      return {
        others: [...here.entries()]
          .filter(([id]) => id !== user.id)
          .map(([id, p]) => ({ userId: id, name: p.name, nodeId: p.nodeId ?? null })),
        updatedAt: flow.updatedAt,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/flows/:id/comments",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const comments = await db
        .select()
        .from(flowComments)
        .where(eq(flowComments.flowId, flow.id))
        .orderBy(asc(flowComments.createdAt));
      return { comments };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/flows/:id/comments",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req, reply) => {
      const body = CommentBody.parse(req.body);
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const user = currentUser(req);
      const [comment] = await db
        .insert(flowComments)
        .values({
          flowId: flow.id,
          nodeId: body.nodeId,
          body: body.body,
          authorId: user.id,
          authorName: user.name ?? user.email ?? "Someone",
        })
        .returning();
      return reply.code(201).send(comment);
    },
  );

  app.patch<{ Params: { id: string; commentId: string } }>(
    "/flows/:id/comments/:commentId",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req) => {
      const { resolved } = z.object({ resolved: z.boolean() }).parse(req.body);
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const [comment] = await db
        .update(flowComments)
        .set({ resolvedAt: resolved ? new Date() : null })
        .where(and(eq(flowComments.id, req.params.commentId), eq(flowComments.flowId, flow.id)))
        .returning();
      if (!comment) throw new HttpError(404, "Comment not found");
      return comment;
    },
  );

  app.delete<{ Params: { id: string; commentId: string } }>(
    "/flows/:id/comments/:commentId",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const user = currentUser(req);
      const ws = currentWorkspace(req);
      const [comment] = await db
        .select()
        .from(flowComments)
        .where(and(eq(flowComments.id, req.params.commentId), eq(flowComments.flowId, flow.id)));
      if (!comment) throw new HttpError(404, "Comment not found");
      if (comment.authorId !== user.id && ws.role !== "admin" && ws.role !== "owner")
        throw new HttpError(403, "Only the author or an admin can delete this comment");
      await db.delete(flowComments).where(eq(flowComments.id, comment.id));
      return reply.code(204).send();
    },
  );
}

const MAX_BATCH = 500;

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF. The first row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** Request bodies arrive as raw strings so signatures can be checked over the exact bytes. */
const rawBody = (req: FastifyRequest) => (typeof req.body === "string" ? req.body : "");

function verifySignature(
  webhook: NonNullable<FlowAutomation["webhook"]>,
  secret: string,
  req: FastifyRequest,
  raw: string,
  publicApiUrl: string,
) {
  const equal = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  if (webhook.signature === "hubspot") {
    // HubSpot v3: base64(HMAC-SHA256(client secret, method + full URL + body + timestamp)), at most 5 minutes old.
    const timestamp = String(req.headers["x-hubspot-request-timestamp"] ?? "");
    if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000)
      throw new HttpError(401, "Missing or stale HubSpot timestamp");
    const uri = `${publicApiUrl}${req.url}`;
    const expected = createHmac("sha256", secret).update(`${req.method}${uri}${raw}${timestamp}`).digest("base64");
    if (!equal(expected, String(req.headers["x-hubspot-signature-v3"] ?? "")))
      throw new HttpError(401, "Invalid HubSpot signature");
    return;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  if (!equal(expected, String(req.headers["x-agentflow-signature"] ?? "")))
    throw new HttpError(401, "Invalid signature");
}

/**
 * Public triggers:
 * - `POST /v1/hooks/:key` starts the flow's live version with the JSON body as `trigger`. AgentFlow-signed hooks
 *   need `x-agentflow-signature: sha256=<hex HMAC of the raw body>`; HubSpot hooks are checked with HubSpot's v3
 *   signature.
 * - `POST /v1/hooks/:key/file` takes a file as the raw body (text, CSV or JSON; name in `x-filename`). CSV rows
 *   are available as `trigger.rows`.
 * - `POST /v1/inbound/email/:key` takes an inbound email (Postmark/Mailgun/JSON); the text is `trigger.message`.
 * With batch mode on, a JSON array or CSV file starts one run per item (up to 500).
 * `?wait=true` waits for the run(s) and returns the result; otherwise it answers 202 straight away.
 */
export async function hookRoutes(app: FastifyInstance, { db, executor, secrets, config }: Deps) {
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );
  app.addContentTypeParser("*", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  async function liveFlow(flow: typeof flows.$inferSelect) {
    if (!flow.liveVersionId) throw new HttpError(409, "This flow is not published");
    const [version] = await db.select().from(flowVersions).where(eq(flowVersions.id, flow.liveVersionId));
    return { version: version!, parsed: Flow.parse(version!.json) };
  }

  /** Starts one run per input. With `wait`, runs one after another and returns their results. */
  async function start(
    req: FastifyRequest<{ Querystring: { wait?: string } }>,
    reply: FastifyReply,
    flow: typeof flows.$inferSelect,
    triggerType: "webhook" | "email",
    inputs: Record<string, unknown>[],
  ) {
    const { version, parsed } = await liveFlow(flow);
    const base = {
      workspaceId: flow.workspaceId,
      flowId: flow.id,
      flowVersionId: version.id,
      flow: parsed,
      triggerType,
    };
    if (req.query.wait === "true") {
      const results = [];
      for (const input of inputs) {
        let result: { outcome?: string; output?: unknown; error?: string } = {};
        const runId = await executor.start({ ...base, input }, (e) => {
          if (e.type === "done") result = { outcome: e.outcome, output: e.output };
          if (e.type === "error") result = { error: e.message };
        });
        results.push({ runId, ...result });
      }
      return inputs.length === 1 ? results[0] : { runs: results };
    }
    // Answer first; runs continue in the background, one after another.
    let resolveFirst!: (id: string) => void;
    const first = new Promise<string>((r) => (resolveFirst = r));
    void (async () => {
      for (const input of inputs) {
        await executor
          .start({ ...base, input }, (e) => {
            if (e.type === "run_started") resolveFirst(e.runId);
          })
          .catch((err) => req.log.error({ err }, "triggered run failed"));
      }
    })();
    const runId = await Promise.race([first, new Promise<string>((r) => setTimeout(() => r(""), 5000))]);
    return reply.code(202).send(inputs.length === 1 ? { runId: runId || null } : { queued: inputs.length });
  }

  async function webhookFlow(req: FastifyRequest<{ Params: { key: string } }>) {
    const [flow] = await db
      .select()
      .from(flows)
      .where(sql`${flows.settings}->'webhook'->>'key' = ${req.params.key}`);
    const webhook = flow && automationOf(flow.settings).webhook;
    if (!flow || !webhook) throw new HttpError(404, "Unknown webhook");
    if (webhook.secretEnc)
      verifySignature(webhook, secrets.decrypt(webhook.secretEnc), req, rawBody(req), config.publicApiUrl);
    return { flow, webhook };
  }

  const asInput = (item: unknown): Record<string, unknown> =>
    item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { data: item };

  function batchOf(items: unknown[], batch: boolean | undefined, whole: Record<string, unknown>) {
    if (!batch) return [whole];
    if (items.length > MAX_BATCH) throw new HttpError(413, `Batches are limited to ${MAX_BATCH} items`);
    return items.map((item, index) => ({ ...asInput(item), batchIndex: index, batchSize: items.length }));
  }

  app.post<{ Params: { key: string }; Querystring: { wait?: string } }>("/hooks/:key", async (req, reply) => {
    const { flow, webhook } = await webhookFlow(req);
    const raw = rawBody(req);
    let parsed: unknown = {};
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "Body must be JSON");
      }
    }
    const inputs = Array.isArray(parsed) ? batchOf(parsed, webhook.batch, { data: parsed }) : [asInput(parsed)];
    if (inputs.length === 0) return reply.code(202).send({ queued: 0 });
    return start(req, reply, flow, "webhook", inputs);
  });

  app.post<{ Params: { key: string }; Querystring: { wait?: string; name?: string } }>(
    "/hooks/:key/file",
    async (req, reply) => {
      const { flow, webhook } = await webhookFlow(req);
      const raw = rawBody(req);
      if (!raw.trim()) throw new HttpError(400, "Send the file as the request body");
      const name = String(req.headers["x-filename"] ?? req.query.name ?? "upload");
      const contentType = String(req.headers["content-type"] ?? "text/plain")
        .split(";")[0]!
        .trim();
      const file = { name, contentType, size: Buffer.byteLength(raw), text: raw.slice(0, 200_000) };
      const isCsv = contentType === "text/csv" || /\.csv$/i.test(name);
      const isJson = contentType === "application/json" || /\.json$/i.test(name);
      let inputs: Record<string, unknown>[];
      if (isCsv) {
        const rows = parseCsv(raw);
        inputs = batchOf(
          rows.map((row) => ({ row, file: { name, contentType } })),
          webhook.batch,
          { file, rows },
        );
      } else if (isJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new HttpError(400, "The file is not valid JSON");
        }
        inputs = Array.isArray(parsed)
          ? batchOf(parsed, webhook.batch, { file, data: parsed })
          : [{ file, data: parsed }];
      } else {
        inputs = [{ file, message: file.text }];
      }
      if (inputs.length === 0) return reply.code(202).send({ queued: 0 });
      return start(req, reply, flow, "webhook", inputs);
    },
  );

  app.post<{ Params: { key: string }; Querystring: { wait?: string } }>("/inbound/email/:key", async (req, reply) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(sql`${flows.settings}->'emailHook'->>'key' = ${req.params.key}`);
    if (!flow || !automationOf(flow.settings).emailHook) throw new HttpError(404, "Unknown inbound address");
    const raw = rawBody(req);
    const contentType = String(req.headers["content-type"] ?? "");
    let fields: Record<string, unknown>;
    try {
      fields = contentType.includes("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(raw))
        : (JSON.parse(raw || "{}") as Record<string, unknown>);
    } catch {
      throw new HttpError(400, "Send the email as JSON or form fields");
    }
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof fields[k] === "string" && fields[k]) return fields[k] as string;
      return "";
    };
    // Field names used by Postmark (From, TextBody), Mailgun (sender, stripped-text) and plain JSON.
    const email = {
      from: pick("From", "from", "sender"),
      to: pick("To", "to", "recipient"),
      subject: pick("Subject", "subject"),
      text: pick("StrippedTextReply", "stripped-text", "TextBody", "body-plain", "text", "body"),
    };
    if (!email.text && !email.subject) throw new HttpError(400, "The email has no subject or text");
    const message = email.text || email.subject;
    return start(req, reply, flow, "email", [{ message, email }]);
  });
}
