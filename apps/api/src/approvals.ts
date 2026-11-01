import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createTransport } from "nodemailer";
import { approvals, customRoles, flows, memberships, runs, users, workspaces, type Db, type Role } from "@agentflow/db";
import type { RunExecutor } from "@agentflow/runtime";
import type { SecretStore } from "@agentflow/secret-store";
import { HttpError } from "./auth";
import { canDecideApproval } from "./permissions";
import type { Channels } from "./channels";

/** Outgoing notifications (H5); swapped for fakes in tests. */
export type Notifier = {
  sendMail(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
  postSlack(webhookUrl: string, body: { text: string }): Promise<void>;
  /** False when no SMTP server is set, so emails are only logged. Omitted means emails are delivered. */
  emailConfigured?: boolean;
};

/** SMTP via EMAIL_SERVER (e.g. smtp://user:pass@host:587). Without it, emails are skipped with a log line. */
export function defaultNotifier(
  emailServer: string | undefined,
  emailFrom: string,
  log: (msg: string) => void,
): Notifier {
  const transport = emailServer ? createTransport(emailServer) : null;
  return {
    emailConfigured: Boolean(transport),
    async sendMail(msg) {
      if (!transport) return log(`EMAIL_SERVER is not set; skipped approval email to ${msg.to}`);
      await transport.sendMail({ from: emailFrom, ...msg });
    },
    async postSlack(webhookUrl, body) {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Slack webhook answered ${res.status}`);
    },
  };
}

// --- Deciding ---------------------------------------------------------------------------------

/**
 * Records a decision and resumes the paused run on its approved/rejected path. Used by the Inbox and by the
 * signed links in approval emails. The approval is claimed atomically so it can't be decided twice.
 */
export async function decideApproval(
  deps: { db: Db; executor: RunExecutor; channels: Channels },
  approvalId: string,
  decision: "approve" | "reject",
  by: { userId: string; label: string },
  note?: string,
) {
  const { db, executor, channels } = deps;
  const [claimed] = await db
    .update(approvals)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: by.userId,
      note,
      decidedAt: new Date(),
    })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning();
  if (!claimed) throw new HttpError(409, "This approval was already decided");

  const handle = decision === "approve" ? "approved" : "rejected";
  let error: string | null = null;
  const later: string[] = [];
  await executor.resume(
    claimed.runId,
    { handle, output: { decision: handle, decidedBy: by.label, note: note ?? null } },
    (e) => {
      if (e.type === "error") error = e.message;
      if (e.type === "message") later.push(e.content);
    },
  );
  // Conversations from Slack, Teams or WhatsApp get the follow-up there (the widget polls for it).
  await channels.notify(claimed.runId, later);
  const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, claimed.runId));
  return { id: claimed.id, decision: handle, runStatus: run?.status, error };
}

// --- Signed links -----------------------------------------------------------------------------

const LINK_TTL_MS = 7 * 24 * 3_600_000;

const sign = (secret: string, parts: string[]) =>
  createHmac("sha256", secret)
    .update(`approval-link:${parts.join(":")}`)
    .digest("base64url");

/** A per-approver link that opens a confirmation page for one decision. */
export function approvalLink(
  publicApiUrl: string,
  secret: string,
  approvalId: string,
  userId: string,
  decision: "approve" | "reject",
  now = Date.now(),
) {
  const exp = String(now + LINK_TTL_MS);
  const sig = sign(secret, [approvalId, userId, decision, exp]);
  const q = new URLSearchParams({ u: userId, d: decision, exp, sig });
  return `${publicApiUrl}/v1/approval-links/${approvalId}?${q}`;
}

function verifyLink(secret: string, approvalId: string, q: Record<string, string | undefined>) {
  const { u, d, exp, sig } = q;
  if (!u || (d !== "approve" && d !== "reject") || !exp || !sig) throw new HttpError(400, "This link is incomplete");
  if (Number(exp) < Date.now()) throw new HttpError(410, "This link has expired; decide in the Inbox instead");
  const expected = Buffer.from(sign(secret, [approvalId, u, d, exp]));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(403, "Invalid link");
  return { userId: u, decision: d as "approve" | "reject" };
}

// --- Notifying ----------------------------------------------------------------------------------

export type NotificationSettings = { emailApprovers?: boolean; slackWebhookEnc?: string };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Emails each member who may decide (with personal approve/reject links) and posts to Slack when configured. */
export async function notifyApprovers(
  deps: { db: Db; secrets: SecretStore; notifier: Notifier; jwtSecret: string; publicApiUrl: string; appUrl: string },
  approvalId: string,
) {
  const { db, notifier } = deps;
  const [row] = await db
    .select({ approval: approvals, flowName: flows.name, settings: workspaces.settings })
    .from(approvals)
    .innerJoin(runs, eq(runs.id, approvals.runId))
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .innerJoin(workspaces, eq(workspaces.id, approvals.workspaceId))
    .where(eq(approvals.id, approvalId));
  if (!row) return { emailed: 0, slack: false };
  const { approval, flowName } = row;
  const prefs = ((row.settings as { notifications?: NotificationSettings }).notifications ??
    {}) as NotificationSettings;
  const inboxUrl = `${deps.appUrl}/inbox`;
  let emailed = 0;

  if (prefs.emailApprovers !== false) {
    const members = await db
      .select({
        id: users.id,
        email: users.email,
        role: memberships.role,
        customRoleId: memberships.customRoleId,
        customPermissions: customRoles.permissions,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(customRoles, eq(customRoles.id, memberships.customRoleId))
      .where(eq(memberships.workspaceId, approval.workspaceId));
    for (const m of members) {
      if (!m.email || !canDecideApproval(m, approval.approverRole as Role)) continue;
      const link = (d: "approve" | "reject") => approvalLink(deps.publicApiUrl, deps.jwtSecret, approval.id, m.id, d);
      const subject = `Approval needed: ${flowName}`;
      const text = `${approval.message}\n\nApprove: ${link("approve")}\nReject: ${link("reject")}\n\nOr open the Inbox: ${inboxUrl}`;
      const html = `<p>${escapeHtml(approval.message).replaceAll("\n", "<br>")}</p>
<p><a href="${link("approve")}">Approve</a> &nbsp;·&nbsp; <a href="${link("reject")}">Reject</a></p>
<p style="color:#666;font-size:12px">Or open the <a href="${inboxUrl}">Inbox</a>. Links expire in 7 days.</p>`;
      await notifier.sendMail({ to: m.email, subject, text, html });
      emailed++;
    }
  }

  let slack = false;
  if (prefs.slackWebhookEnc) {
    await notifier.postSlack(deps.secrets.decrypt(prefs.slackWebhookEnc), {
      text: `:raised_hand: *Approval needed* in _${flowName}_ (${approval.approverRole} or higher)\n>${approval.message.replaceAll("\n", "\n>")}\n<${inboxUrl}|Open the Inbox>`,
    });
    slack = true;
  }
  return { emailed, slack };
}

// --- Public link pages ---------------------------------------------------------------------------

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 16px;color:#1f2937}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:24px}button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#6d28d9;color:#fff;cursor:pointer}
.reject{background:#be123c}textarea{width:100%;box-sizing:border-box;margin:12px 0;font:inherit;padding:8px;border:1px solid #d1d5db;border-radius:8px}
blockquote{margin:12px 0;padding:8px 12px;background:#f9fafb;border-left:3px solid #d1d5db;white-space:pre-wrap}</style></head>
<body><div class="card">${body}</div></body></html>`;

/**
 * Pages behind the links in approval emails. Opening a link only shows a confirmation page (so mail scanners
 * that prefetch links can't decide anything); the decision is made by the form's POST.
 */
export async function approvalLinkRoutes(
  app: FastifyInstance,
  deps: { db: Db; executor: RunExecutor; channels: Channels; jwtSecret: string },
) {
  const { db } = deps;
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof HttpError ? error.statusCode : 500;
    return reply
      .code(status)
      .type("text/html")
      .send(
        page(
          "Approval",
          `<h2>Couldn't record that</h2><p>${escapeHtml(status === 500 ? "Something went wrong." : (error as Error).message)}</p>`,
        ),
      );
  });

  async function load(approvalId: string, q: Record<string, string | undefined>) {
    const { userId, decision } = verifyLink(deps.jwtSecret, approvalId, q);
    const [row] = await db
      .select({
        approval: approvals,
        flowName: flows.name,
        role: memberships.role,
        customRoleId: memberships.customRoleId,
        customPermissions: customRoles.permissions,
        email: users.email,
      })
      .from(approvals)
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .innerJoin(memberships, and(eq(memberships.workspaceId, approvals.workspaceId), eq(memberships.userId, userId)))
      .innerJoin(users, eq(users.id, userId))
      .leftJoin(customRoles, eq(customRoles.id, memberships.customRoleId))
      .where(eq(approvals.id, approvalId));
    if (!row) throw new HttpError(404, "This approval no longer exists, or you are no longer a member");
    if (!canDecideApproval(row, row.approval.approverRole as Role))
      throw new HttpError(403, "Your role can't decide this approval");
    return { ...row, userId, decision };
  }

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    "/approval-links/:id",
    async (req, reply) => {
      const row = await load(req.params.id, req.query);
      reply.type("text/html").header("cache-control", "no-store").header("x-robots-tag", "noindex");
      if (row.approval.status !== "pending")
        return page("Approval", `<h2>Already decided</h2><p>This request was ${row.approval.status}.</p>`);
      const verb = row.decision === "approve" ? "Approve" : "Reject";
      const hidden = ["u", "d", "exp", "sig"]
        .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(req.query[k] ?? "")}">`)
        .join("");
      return page(
        `${verb} request`,
        `<p style="color:#6b7280;margin:0">${escapeHtml(row.flowName)}</p><h2 style="margin-top:4px">${verb} this request?</h2>
<blockquote>${escapeHtml(row.approval.message)}</blockquote>
<form method="post">${hidden}<label>Note (optional)<textarea name="note" rows="2" maxlength="1000"></textarea></label>
<button type="submit" class="${row.decision === "reject" ? "reject" : ""}">${verb}</button></form>`,
      );
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, string | undefined> }>(
    "/approval-links/:id",
    async (req, reply) => {
      const row = await load(req.params.id, req.body ?? {});
      const note = req.body?.note?.trim().slice(0, 1000) || undefined;
      const result = await decideApproval(
        deps,
        row.approval.id,
        row.decision,
        { userId: row.userId, label: row.email ?? row.userId },
        note,
      );
      reply.type("text/html").header("cache-control", "no-store");
      return page(
        "Recorded",
        `<h2>${result.decision === "approved" ? "Approved" : "Rejected"}</h2><p>Thanks — the conversation has continued${result.error ? `, but the flow then failed: ${escapeHtml(result.error)}` : ""}.</p>`,
      );
    },
  );
}
