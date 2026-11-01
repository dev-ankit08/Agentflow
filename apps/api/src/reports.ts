import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { memberships, users, workspaces, type Db } from "@agentflow/db";
import type { Notifier } from "./approvals";
import { analyticsSummary } from "./routes/analytics";

export type ReportSettings = {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday (UTC). */
  weekday: number;
  hourUtc: number;
  /** Extra recipients besides the workspace's owners and admins. */
  extraRecipients: string[];
  lastSentAt?: string;
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const change = (now: number, before: number) => {
  if (before === 0) return now === 0 ? "" : " (new)";
  const d = Math.round(((now - before) / before) * 100);
  return ` (${d >= 0 ? "+" : ""}${d}% vs previous week)`;
};
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The weekly report for one workspace: last 7 days, compared with the 7 before. */
export async function buildReport(db: Db, workspaceId: string, appUrl: string) {
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const week = await analyticsSummary(db, workspaceId, 7);
  const fortnight = await analyticsSummary(db, workspaceId, 14);
  const t = week.totals;
  const prev = {
    runs: fortnight.totals.runs - t.runs,
    automated: fortnight.totals.resolved + fortnight.totals.converted - (t.resolved + t.converted),
  };
  const automated = t.resolved + t.converted;
  const rows: [string, string][] = [
    ["Conversations", `${t.runs}${change(t.runs, prev.runs)}`],
    ["Handled without a person", `${automated} · ${pct(t.resolutionRate)}${change(automated, prev.automated)}`],
    ["Hours saved", week.roi.hoursSaved.toFixed(1)],
    ["Net savings", money(week.roi.netSavingsUsd)],
    ["AI cost", money(t.aiCostUsd)],
    ["Satisfaction", t.csat == null ? "no ratings yet" : `${pct((t.csat - 1) / 4)} (${t.feedbackCount} ratings)`],
  ];
  const top = week.byFlow.slice(0, 3);
  const subject = `${ws?.name ?? "AgentFlow"} weekly report: ${t.runs} conversations, ${pct(t.resolutionRate)} automated`;
  const text = [
    `Your agents in the last 7 days:`,
    ...rows.map(([k, v]) => `- ${k}: ${v}`),
    ...(top.length
      ? ["", "Busiest flows:", ...top.map((f) => `- ${f.name}: ${f.runs} conversations, ${f.resolved} automated`)]
      : []),
    "",
    `Full dashboard: ${appUrl}/analytics?days=7`,
  ].join("\n");
  const html = `<h2 style="font-family:system-ui,sans-serif">${escapeHtml(ws?.name ?? "AgentFlow")}: the last 7 days</h2>
<table style="font-family:system-ui,sans-serif;border-collapse:collapse">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:4px 0"><b>${escapeHtml(v)}</b></td></tr>`,
    )
    .join("")}</table>${
    top.length
      ? `<h3 style="font-family:system-ui,sans-serif">Busiest flows</h3><ul style="font-family:system-ui,sans-serif">${top
          .map((f) => `<li>${escapeHtml(f.name)}: ${f.runs} conversations, ${f.resolved} automated</li>`)
          .join("")}</ul>`
      : ""
  }<p style="font-family:system-ui,sans-serif"><a href="${appUrl}/analytics?days=7">Open the dashboard</a></p>`;
  return { subject, text, html };
}

/** Owners and admins with an email address, plus any extra recipients. */
async function recipients(db: Db, workspaceId: string, extra: string[]) {
  const admins = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        inArray(memberships.role, ["owner", "admin"]),
        isNotNull(users.email),
      ),
    );
  return [...new Set([...admins.map((a) => a.email!.toLowerCase()), ...extra.map((e) => e.toLowerCase())])];
}

export async function sendReport(db: Db, notifier: Notifier, appUrl: string, workspaceId: string, to: string[]) {
  const report = await buildReport(db, workspaceId, appUrl);
  for (const address of to) await notifier.sendMail({ to: address, ...report });
  return { sent: to.length, subject: report.subject };
}

/** Sends due weekly reports (the sweep calls this; each workspace gets at most one per day). */
export async function sendDueReports(db: Db, notifier: Notifier, appUrl: string, now = new Date()) {
  const due = await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(sql`(${workspaces.settings}->'reports'->>'enabled')::boolean is true`);
  const today = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const ws of due) {
    const r = ws.settings.reports as ReportSettings;
    if (now.getUTCDay() !== r.weekday || now.getUTCHours() < r.hourUtc) continue;
    if (r.lastSentAt?.slice(0, 10) === today) continue;
    // Claim today's report atomically (touching only lastSentAt), so overlapping sweeps send it once.
    const claimed = await db
      .update(workspaces)
      .set({
        settings: sql`jsonb_set(${workspaces.settings}, '{reports,lastSentAt}', to_jsonb(${now.toISOString()}::text))`,
      })
      .where(
        and(
          eq(workspaces.id, ws.id),
          sql`coalesce(left(${workspaces.settings}->'reports'->>'lastSentAt', 10), '') <> ${today}`,
        ),
      )
      .returning({ id: workspaces.id });
    if (!claimed.length) continue;
    const to = await recipients(db, ws.id, r.extraRecipients ?? []);
    sent += (await sendReport(db, notifier, appUrl, ws.id, to)).sent;
  }
  return sent;
}
