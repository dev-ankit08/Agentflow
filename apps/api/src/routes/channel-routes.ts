import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { channelConnections, flows } from "@agentflow/db";
import { HttpError, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { verifySlack, verifyTeams, verifyWhatsApp, type ChannelRow } from "../channels";

const NewChannel = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("slack"),
    flowId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    secrets: z.object({ botToken: z.string().min(1), signingSecret: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("teams"),
    flowId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    config: z.object({ appId: z.string().min(1), tenantId: z.string().optional() }),
    secrets: z.object({ appPassword: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("whatsapp"),
    flowId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    config: z.object({ phoneNumberId: z.string().min(1) }),
    secrets: z.object({ accessToken: z.string().min(1), appSecret: z.string().min(1), verifyToken: z.string().min(8) }),
  }),
]);

type Raw = FastifyRequest & { rawBody?: string };

/** Admin endpoints for Slack, Teams and WhatsApp connections, plus their public webhooks. */
export async function channelRoutes(app: FastifyInstance, deps: Deps) {
  const { db, auth, secrets, channels, config } = deps;
  const publicUrl = (row: ChannelRow) => {
    const base = `${config.publicApiUrl}/v1/channels/${row.type}/${row.id}`;
    return row.type === "slack" ? `${base}/events` : row.type === "teams" ? `${base}/messages` : `${base}/webhook`;
  };

  app.get<{ Querystring: { flowId?: string } }>(
    "/channels",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const ws = currentWorkspace(req);
      const rows = await db
        .select()
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.workspaceId, ws.id),
            req.query.flowId ? eq(channelConnections.flowId, req.query.flowId) : undefined,
          ),
        )
        .orderBy(desc(channelConnections.createdAt));
      return {
        channels: rows.map(({ encSecrets: _s, ...r }) => ({ ...r, webhookUrl: publicUrl({ ...r, encSecrets: "" }) })),
      };
    },
  );

  app.post("/channels", { preHandler: auth.requireWorkspace("admin") }, async (req, reply) => {
    const body = NewChannel.parse(req.body);
    const ws = currentWorkspace(req);
    const [flow] = await db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, body.flowId), eq(flows.workspaceId, ws.id)));
    if (!flow) throw new HttpError(404, "Flow not found");
    const [row] = await db
      .insert(channelConnections)
      .values({
        workspaceId: ws.id,
        flowId: flow.id,
        type: body.type,
        name: body.name,
        config: "config" in body ? body.config : {},
        encSecrets: secrets.encrypt(JSON.stringify(body.secrets)),
      })
      .returning();
    const { encSecrets: _s, ...rest } = row!;
    return reply.code(201).send({ ...rest, webhookUrl: publicUrl(row!) });
  });

  app.delete<{ Params: { id: string } }>(
    "/channels/:id",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await db
        .delete(channelConnections)
        .where(and(eq(channelConnections.id, req.params.id), eq(channelConnections.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );

  // --- Public webhooks (each verifies the platform's signature on the raw body) -------------------

  await app.register(async (hooks) => {
    hooks.removeContentTypeParser("application/json");
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as Raw).rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    });

    const load = async (type: ChannelRow["type"], id: string) => {
      const [row] = await db
        .select()
        .from(channelConnections)
        .where(and(eq(channelConnections.id, id), eq(channelConnections.type, type)));
      if (!row) throw new HttpError(404, "Unknown channel");
      return row;
    };
    /** Platforms expect a fast 200; the conversation is processed afterwards (synchronously in tests). */
    const later = async (work: () => Promise<void>) => {
      const run = work().catch((e) => app.log.error({ err: e }, "channel message failed"));
      if (config.syncChannels) await run;
    };

    hooks.post<{ Params: { id: string } }>("/channels/slack/:id/events", async (req, reply) => {
      const row = await load("slack", req.params.id);
      const raw = (req as Raw).rawBody ?? "";
      const ok = verifySlack(
        channels.secretsOf(row).signingSecret ?? "",
        req.headers["x-slack-request-timestamp"] as string | undefined,
        req.headers["x-slack-signature"] as string | undefined,
        raw,
      );
      if (!ok) throw new HttpError(401, "Invalid Slack signature");
      const body = req.body as {
        type: string;
        challenge?: string;
        event?: {
          type: string;
          text?: string;
          user?: string;
          bot_id?: string;
          subtype?: string;
          channel: string;
          ts: string;
          thread_ts?: string;
        };
      };
      if (body.type === "url_verification") return reply.send({ challenge: body.challenge });
      // Slack retries when we are slow; the first delivery is already being handled.
      if (req.headers["x-slack-retry-num"]) return reply.send({ ok: true });
      const e = body.event;
      if (
        body.type === "event_callback" &&
        e &&
        (e.type === "message" || e.type === "app_mention") &&
        !e.bot_id &&
        !e.subtype &&
        e.text
      ) {
        const text = e.text.replace(/<@[A-Z0-9]+>/g, "").trim();
        const threadTs = e.thread_ts ?? e.ts;
        await later(() =>
          channels.handle(
            row,
            `${e.channel}:${threadTs}`,
            text,
            { type: "slack", channel: e.channel, threadTs },
            e.user ? { id: e.user } : {},
          ),
        );
      }
      return reply.send({ ok: true });
    });

    hooks.post<{ Params: { id: string } }>("/channels/teams/:id/messages", async (req, reply) => {
      const row = await load("teams", req.params.id);
      const activity = req.body as {
        type: string;
        id: string;
        text?: string;
        serviceUrl: string;
        conversation: { id: string };
        from?: { id: string; name?: string; aadObjectId?: string };
      };
      if (
        !(await verifyTeams(
          deps.channelEndpoints,
          row.config.appId ?? "",
          req.headers.authorization,
          activity.serviceUrl,
        ))
      ) {
        throw new HttpError(401, "Invalid Bot Framework token");
      }
      if (activity.type === "message" && activity.text) {
        const text = activity.text.replace(/<at>[^<]*<\/at>/g, "").trim();
        await later(() =>
          channels.handle(
            row,
            activity.conversation.id,
            text,
            {
              type: "teams",
              serviceUrl: activity.serviceUrl,
              conversationId: activity.conversation.id,
              replyToId: activity.id,
            },
            activity.from ? { id: activity.from.aadObjectId ?? activity.from.id, name: activity.from.name } : {},
            { serviceUrl: activity.serviceUrl },
          ),
        );
      }
      return reply.code(200).send();
    });

    /** Meta's one-time webhook verification handshake. */
    hooks.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
      "/channels/whatsapp/:id/webhook",
      async (req, reply) => {
        const row = await load("whatsapp", req.params.id);
        const q = req.query;
        if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === channels.secretsOf(row).verifyToken) {
          return reply.type("text/plain").send(q["hub.challenge"] ?? "");
        }
        throw new HttpError(403, "Verification failed");
      },
    );

    hooks.post<{ Params: { id: string } }>("/channels/whatsapp/:id/webhook", async (req, reply) => {
      const row = await load("whatsapp", req.params.id);
      const raw = (req as Raw).rawBody ?? "";
      if (
        !verifyWhatsApp(
          channels.secretsOf(row).appSecret ?? "",
          req.headers["x-hub-signature-256"] as string | undefined,
          raw,
        )
      ) {
        throw new HttpError(401, "Invalid signature");
      }
      const body = req.body as {
        entry?: {
          changes?: {
            value?: {
              messages?: { from: string; type: string; text?: { body: string } }[];
              contacts?: { profile?: { name?: string } }[];
            };
          }[];
        }[];
      };
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const name = change.value?.contacts?.[0]?.profile?.name;
          for (const m of change.value?.messages ?? []) {
            if (m.type !== "text" || !m.text?.body) continue;
            await later(() =>
              channels.handle(row, m.from, m.text!.body, { type: "whatsapp", to: m.from }, { id: m.from, name }),
            );
          }
        }
      }
      return reply.code(200).send();
    });
  });
}
