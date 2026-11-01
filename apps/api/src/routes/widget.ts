import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { z } from "zod";
import { feedback, flows } from "@agentflow/db";
import { Flow } from "@agentflow/flow-schema";
import { HttpError } from "../auth";
import type { Deps } from "../app";
import { isPublicEvent, openSse } from "../sse";
import { widgetSettingsOf, type WidgetSettings } from "./publish";
import { chooseVersion } from "../automation";

const StartSession = z.object({
  message: z.string().trim().min(1).max(4000),
  identityToken: z.string().max(4096).optional(),
});
const SendMessage = z.object({ message: z.string().trim().min(1).max(4000), sessionToken: z.string().min(1) });

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** With no allowed origins configured, only local pages may embed the agent. */
export function originAllowed(origin: string | undefined, widget: WidgetSettings) {
  if (!origin) return true;
  if (widget.allowedOrigins.length === 0) return LOCAL_ORIGIN.test(origin);
  return widget.allowedOrigins.includes(origin);
}

/** Small fixed-window limiter per client and widget (in memory for the prototype). */
function makeLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    return ++entry.count <= limit;
  };
}

/** Public endpoints used by the embeddable widget (docs/02-feature-spec.md §7.1). */
export async function widgetRoutes(app: FastifyInstance, { db, executor, store, secrets, config, billing }: Deps) {
  const limiter = makeLimiter(30, 60_000);
  const sign = (runId: string) =>
    createHmac("sha256", config.API_JWT_SECRET).update(`widget:${runId}`).digest("base64url");
  const verify = (runId: string, token: string) => {
    const expected = Buffer.from(sign(runId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  async function loadWidget(req: FastifyRequest<{ Params: { key: string } }>) {
    const [flow] = await db.select().from(flows).where(eq(flows.widgetKey, req.params.key));
    if (!flow) throw new HttpError(404, "Unknown widget");
    const widget = widgetSettingsOf(flow.settings);
    if (!originAllowed(req.headers.origin, widget))
      throw new HttpError(403, "This website is not allowed to use this agent");
    if (!limiter(`${req.ip}:${req.params.key}`)) throw new HttpError(429, "Too many messages; please wait a moment");
    return { flow, widget };
  }

  app.get<{ Params: { key: string } }>("/widget/:key/config", async (req) => {
    const { flow, widget } = await loadWidget(req);
    return {
      title: widget.title,
      welcome: widget.welcome,
      color: widget.color,
      quickReplies: widget.quickReplies,
      live: Boolean(flow.liveVersionId),
    };
  });

  app.post<{ Params: { key: string } }>("/widget/:key/sessions", async (req, reply) => {
    const body = StartSession.parse(req.body);
    const { flow, widget } = await loadWidget(req);
    if (!flow.liveVersionId) throw new HttpError(409, "This agent is not published yet");
    await billing.checkConversationLimit(flow.workspaceId);
    // During an A/B test, a share of new conversations runs the challenger version.
    const version = await chooseVersion(db, flow);
    if (!version) throw new HttpError(409, "This agent is not published yet");

    let user: Record<string, unknown> = {};
    if (body.identityToken) {
      if (!widget.identitySecretEnc) throw new HttpError(400, "Identity tokens are not enabled for this agent");
      try {
        const key = new TextEncoder().encode(secrets.decrypt(widget.identitySecretEnc));
        const { payload } = await jwtVerify(body.identityToken, key, { algorithms: ["HS256"] });
        const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = payload;
        user = { ...claims, id: payload.sub };
      } catch {
        throw new HttpError(401, "Invalid identity token");
      }
    }

    const sse = openSse(reply);
    try {
      await executor.start(
        {
          workspaceId: flow.workspaceId,
          flowId: flow.id,
          flowVersionId: version.id,
          flow: Flow.parse(version.json),
          triggerType: "chat",
          input: { message: body.message, channel: "widget" },
          user,
          endUserId: typeof user.id === "string" ? user.id : null,
        },
        (event) => {
          if (isPublicEvent(event)) sse.send(event);
          if (event.type === "run_started")
            sse.sendRaw("session", { runId: event.runId, sessionToken: sign(event.runId) });
        },
      );
    } catch (error) {
      sse.send({ type: "error", message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  app.post<{ Params: { key: string; runId: string } }>("/widget/:key/sessions/:runId/messages", async (req, reply) => {
    const body = SendMessage.parse(req.body);
    const { flow } = await loadWidget(req);
    if (!verify(req.params.runId, body.sessionToken)) throw new HttpError(403, "Invalid session");
    const run = await store.load(req.params.runId);
    if (!run || run.flowId !== flow.id) throw new HttpError(404, "Session not found");
    if (run.status === "waiting_approval") {
      throw new HttpError(423, "A team member is reviewing your request; I'll reply here as soon as they decide.");
    }
    if (run.status === "waiting_timer") {
      throw new HttpError(423, "I'll follow up here shortly; there's nothing you need to do right now.");
    }
    if (run.status !== "waiting_input") throw new HttpError(409, "This conversation has ended; please start a new one");
    const sse = openSse(reply);
    try {
      await executor.sendMessage(run.id, body.message, (event) => isPublicEvent(event) && sse.send(event));
    } catch (error) {
      sse.send({ type: "error", message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  /** Lets the widget pick up replies that arrive later, e.g. after a team member approves a request. */
  app.get<{ Params: { key: string; runId: string }; Querystring: { sessionToken?: string } }>(
    "/widget/:key/sessions/:runId",
    async (req) => {
      const { flow } = await loadWidget(req);
      if (!req.query.sessionToken || !verify(req.params.runId, req.query.sessionToken))
        throw new HttpError(403, "Invalid session");
      const run = await store.load(req.params.runId);
      if (!run || run.flowId !== flow.id) throw new HttpError(404, "Session not found");
      const form =
        run.state.paused?.reason === "form" ? run.flow.nodes.find((n) => n.id === run.state.paused!.nodeId) : undefined;
      return {
        status: run.status,
        messages: run.state.conversation,
        form:
          form?.type === "form"
            ? { title: form.config.title, submitLabel: form.config.submitLabel, fields: form.config.fields }
            : null,
      };
    },
  );

  app.post<{ Params: { key: string; runId: string } }>("/widget/:key/sessions/:runId/feedback", async (req, reply) => {
    const body = z
      .object({
        sessionToken: z.string().min(1),
        rating: z.union([z.literal(1), z.literal(5)]),
        comment: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const { flow } = await loadWidget(req);
    if (!verify(req.params.runId, body.sessionToken)) throw new HttpError(403, "Invalid session");
    const run = await store.load(req.params.runId);
    if (!run || run.flowId !== flow.id) throw new HttpError(404, "Session not found");
    await db
      .insert(feedback)
      .values({ runId: run.id, rating: body.rating, comment: body.comment })
      .onConflictDoUpdate({ target: feedback.runId, set: { rating: body.rating, comment: body.comment } });
    return reply.code(204).send();
  });
}
