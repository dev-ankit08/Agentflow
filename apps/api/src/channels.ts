import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { channelConnections, channelThreads, flows, type Db } from "@agentflow/db";
import { Flow } from "@agentflow/flow-schema";
import type { RunEvent, RunExecutor, RunStore } from "@agentflow/runtime";
import type { SecretStore } from "@agentflow/secret-store";
import { chooseVersion } from "./automation";

export type ChannelType = "slack" | "teams" | "whatsapp";
export type ChannelRow = typeof channelConnections.$inferSelect;

/** Platform API base URLs; overridable so tests can point at local fakes. */
export type ChannelEndpoints = {
  slackApi: string;
  whatsappGraph: string;
  teamsToken: (tenantId?: string) => string;
  teamsJwks: JWTVerifyGetKey;
  teamsIssuer: string;
};

export const defaultEndpoints = (): ChannelEndpoints => ({
  slackApi: "https://slack.com/api",
  whatsappGraph: "https://graph.facebook.com/v21.0",
  teamsToken: (tenantId) => `https://login.microsoftonline.com/${tenantId || "botframework.com"}/oauth2/v2.0/token`,
  teamsJwks: createRemoteJWKSet(new URL("https://login.botframework.com/v1/.well-known/keys")),
  teamsIssuer: "https://api.botframework.com",
});

/** Where to send a reply for one external conversation. */
export type ReplyTarget =
  | { type: "slack"; channel: string; threadTs: string }
  | { type: "teams"; serviceUrl: string; conversationId: string; replyToId?: string }
  | { type: "whatsapp"; to: string };

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Slack request signing: v0=HMAC-SHA256(signing secret, "v0:{timestamp}:{raw body}"), max 5 minutes old. */
export function verifySlack(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  raw: string,
) {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return safeEqual(expected, signature);
}

/** WhatsApp (Meta) webhook signing: sha256=HMAC-SHA256(app secret, raw body). */
export function verifyWhatsApp(appSecret: string, signature: string | undefined, raw: string) {
  if (!signature) return false;
  return safeEqual(`sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`, signature);
}

/** Bot Framework: a JWT signed by Microsoft, for our app id, whose serviceUrl matches the activity. */
export async function verifyTeams(
  endpoints: ChannelEndpoints,
  appId: string,
  authorization: string | undefined,
  serviceUrl: string,
) {
  if (!authorization?.startsWith("Bearer ")) return false;
  try {
    const { payload } = await jwtVerify(authorization.slice(7), endpoints.teamsJwks, {
      issuer: endpoints.teamsIssuer,
      audience: appId,
      clockTolerance: 300,
    });
    return !payload.serviceurl || payload.serviceurl === serviceUrl;
  } catch {
    return false;
  }
}

export function makeChannels(opts: {
  db: Db;
  secrets: SecretStore;
  executor: RunExecutor;
  store: RunStore;
  endpoints: ChannelEndpoints;
  log: (msg: string, err?: unknown) => void;
  /** Throws (e.g. plan limit reached) to stop a new conversation; its message is sent to the user. */
  beforeNewRun?: (workspaceId: string) => Promise<void>;
}) {
  const { db, secrets, executor, store, endpoints, log, beforeNewRun } = opts;
  const teamsTokens = new Map<string, { token: string; expires: number }>();

  const secretsOf = (row: ChannelRow) => JSON.parse(secrets.decrypt(row.encSecrets)) as Record<string, string>;

  async function teamsToken(row: ChannelRow) {
    const cached = teamsTokens.get(row.id);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const res = await fetch(endpoints.teamsToken(row.config.tenantId), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: row.config.appId ?? "",
        client_secret: secretsOf(row).appPassword ?? "",
        scope: "https://api.botframework.com/.default",
      }).toString(),
    });
    if (!res.ok) throw new Error(`Teams token request failed (${res.status})`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    teamsTokens.set(row.id, { token: data.access_token, expires: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  }

  /** Sends text replies to the conversation on its platform. */
  async function send(row: ChannelRow, target: ReplyTarget, texts: string[]) {
    for (const text of texts.filter(Boolean)) {
      let res: Response;
      if (target.type === "slack") {
        res = await fetch(`${endpoints.slackApi}/chat.postMessage`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${secretsOf(row).botToken}`,
          },
          body: JSON.stringify({ channel: target.channel, thread_ts: target.threadTs, text }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!body.ok) throw new Error(`Slack chat.postMessage failed: ${body.error ?? res.status}`);
      } else if (target.type === "teams") {
        // A reply to the incoming activity, or (for later messages) a new message in the conversation.
        const base = `${target.serviceUrl.replace(/\/?$/, "/")}v3/conversations/${encodeURIComponent(target.conversationId)}/activities`;
        const url = target.replyToId ? `${base}/${encodeURIComponent(target.replyToId)}` : base;
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${await teamsToken(row)}` },
          body: JSON.stringify({ type: "message", text, ...(target.replyToId && { replyToId: target.replyToId }) }),
        });
        if (!res.ok) throw new Error(`Teams reply failed (${res.status})`);
      } else {
        res = await fetch(`${endpoints.whatsappGraph}/${row.config.phoneNumberId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secretsOf(row).accessToken}` },
          body: JSON.stringify({ messaging_product: "whatsapp", to: target.to, type: "text", text: { body: text } }),
        });
        if (!res.ok) throw new Error(`WhatsApp send failed (${res.status})`);
      }
    }
  }

  /** Chat platforms have no form UI: a Form node becomes a text prompt listing what to send. */
  const describe = (e: RunEvent) =>
    e.type === "paused" && e.reason === "form" && e.ui
      ? `Please reply with: ${e.ui.fields.map((f) => f.label + (f.options?.length ? ` (${f.options.join(" / ")})` : "")).join(", ")}`
      : null;

  /**
   * Handles one incoming message: continues the conversation's run (or starts one on the flow's live
   * version) and sends every assistant message back to the platform.
   */
  async function handle(
    row: ChannelRow,
    externalId: string,
    text: string,
    target: ReplyTarget,
    user: Record<string, unknown> = {},
    meta: Record<string, string> = {},
  ) {
    const replies: string[] = [];
    const collect = (e: RunEvent) => {
      if (e.type === "message") replies.push(e.content);
      const extra = describe(e);
      if (extra) replies.push(extra);
      if (e.type === "error") replies.push("Sorry, something went wrong. Please try again in a moment.");
    };
    const [thread] = await db
      .select()
      .from(channelThreads)
      .where(and(eq(channelThreads.channelId, row.id), eq(channelThreads.externalId, externalId)));
    const run = thread ? await store.load(thread.runId) : null;

    if (run?.status === "waiting_approval") {
      replies.push("A team member is still reviewing your request — I'll reply here as soon as they decide.");
    } else if (run?.status === "waiting_timer") {
      replies.push("I'll follow up here shortly; there's nothing you need to do right now.");
    } else if (run?.status === "waiting_input") {
      await executor.sendMessage(run.id, text, collect);
    } else {
      const [flow] = await db.select().from(flows).where(eq(flows.id, row.flowId));
      const version = flow ? await chooseVersion(db, flow) : null;
      const blocked =
        flow && version
          ? await beforeNewRun?.(flow.workspaceId).then(
              () => null,
              (e: Error) => e.message,
            )
          : null;
      if (!flow || !version) {
        replies.push("This assistant isn't published yet.");
      } else if (blocked) {
        replies.push(blocked);
      } else {
        const runId = await executor.start(
          {
            workspaceId: row.workspaceId,
            flowId: flow.id,
            flowVersionId: version.id,
            flow: Flow.parse(version.json),
            triggerType: "chat",
            input: { message: text, channel: row.type },
            user,
            endUserId: typeof user.id === "string" ? user.id : null,
          },
          collect,
        );
        await db
          .insert(channelThreads)
          .values({ channelId: row.id, externalId, runId, meta })
          .onConflictDoUpdate({
            target: [channelThreads.channelId, channelThreads.externalId],
            set: { runId, meta, createdAt: new Date() },
          });
      }
    }
    await send(row, target, replies);
  }

  /** Delivers messages produced later (e.g. after an Inbox approval) to the run's channel conversation. */
  async function notify(runId: string, texts: string[]) {
    if (texts.length === 0) return;
    const [thread] = await db.select().from(channelThreads).where(eq(channelThreads.runId, runId));
    if (!thread) return;
    const [row] = await db.select().from(channelConnections).where(eq(channelConnections.id, thread.channelId));
    if (!row) return;
    const target = targetFromThread(row, thread.externalId, thread.meta);
    if (target) await send(row, target, texts).catch((e) => log(`channel notify failed for run ${runId}`, e));
  }

  return { handle, notify, send, secretsOf };
}

export type Channels = ReturnType<typeof makeChannels>;

/**
 * External ids: Slack "{channel}:{thread ts}", Teams "{conversation id}" (serviceUrl kept in meta),
 * WhatsApp "{phone number}".
 */
export function targetFromThread(
  row: ChannelRow,
  externalId: string,
  meta: Record<string, string>,
): ReplyTarget | null {
  if (row.type === "slack") {
    const [channel, threadTs] = externalId.split(":");
    return channel && threadTs ? { type: "slack", channel, threadTs } : null;
  }
  if (row.type === "teams")
    return meta.serviceUrl ? { type: "teams", serviceUrl: meta.serviceUrl, conversationId: externalId } : null;
  return { type: "whatsapp", to: externalId };
}
