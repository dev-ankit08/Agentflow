import Link from "next/link";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@agentflow/ui";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";

type Analytics = {
  days: number;
  totals: {
    runs: number;
    resolved: number;
    escalated: number;
    converted: number;
    failed: number;
    resolutionRate: number | null;
    tokens: number;
    aiCostUsd: number;
    csat: number | null;
    feedbackCount: number;
  };
  roi: {
    baseline: { costPerConversation: number; minutesPerConversation: number };
    baselineIsDefault: boolean;
    hoursSaved: number;
    grossSavingsUsd: number;
    netSavingsUsd: number;
  };
  daily: { day: string; runs: number; resolved: number }[];
  byFlow: { flowId: string; name: string; runs: number; resolved: number; escalated: number }[];
};

type Insights = {
  total: number;
  clusters: {
    topic: string;
    count: number;
    escalated: number;
    failed: number;
    negative: number;
    problemRate: number;
    examples: { runId: string; message: string }[];
    suggestion: string | null;
  }[];
};

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 2 : 0 });
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const RANGES = [7, 30, 90];

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </Card>
  );
}

/** Daily conversations (single series): thin bars anchored to the baseline, hover shows the values. */
function DailyChart({ daily, days }: { daily: Analytics["daily"]; days: number }) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(date) ?? { day: date, runs: 0, resolved: 0 };
  });
  const max = Math.max(1, ...series.map((d) => d.runs));
  return (
    <div>
      <div
        className="flex h-40 items-end gap-[2px] border-b border-border"
        role="img"
        aria-label={`Conversations per day, last ${days} days`}
      >
        {series.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end">
            <div
              className="w-full rounded-t-[4px] bg-accent transition-opacity group-hover:opacity-80"
              style={{ height: `${(d.runs / max) * 100}%`, minHeight: d.runs ? 2 : 0 }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text shadow-sm group-hover:block">
              {d.day}: {d.runs} conversation{d.runs === 1 ? "" : "s"}, {d.resolved} automated
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{series[0]?.day}</span>
        <span>{series.at(-1)?.day}</span>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-accent">Show as table</summary>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 font-medium">Conversations</th>
              <th className="py-1 font-medium">Automated</th>
            </tr>
          </thead>
          <tbody>
            {series
              .filter((d) => d.runs)
              .map((d) => (
                <tr key={d.day} className="border-t border-border text-text">
                  <td className="py-1">{d.day}</td>
                  <td className="py-1 tabular-nums">{d.runs}</td>
                  <td className="py-1 tabular-nums">{d.resolved}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { current } = await requireWorkspace();
  const days = RANGES.includes(Number((await searchParams).days)) ? Number((await searchParams).days) : 30;
  const [a, insights] = await Promise.all([
    apiFetch<Analytics>(`/v1/analytics?days=${days}`, { workspaceId: current.id }),
    apiFetch<Insights>(`/v1/insights?days=${days}`, { workspaceId: current.id }),
  ]);
  const t = a.totals;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="What your agents handled, and what that saved compared with people doing the same work."
        action={
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted">
              Export CSV:{" "}
              <a href={`/api/v1/analytics?days=${days}&format=csv`} className="text-accent hover:underline" download>
                by day
              </a>{" "}
              ·{" "}
              <a
                href={`/api/v1/analytics?days=${days}&format=csv&table=flows`}
                className="text-accent hover:underline"
                download
              >
                by flow
              </a>
            </span>
            <div className="flex gap-1 rounded-lg border border-border p-0.5" role="group" aria-label="Time range">
              {RANGES.map((d) => (
                <Link
                  key={d}
                  href={`/analytics?days=${d}`}
                  aria-current={d === days ? "true" : undefined}
                  className={
                    d === days
                      ? "rounded-md bg-accent-soft px-3 py-1 text-sm font-medium text-accent"
                      : "rounded-md px-3 py-1 text-sm text-muted hover:text-text"
                  }
                >
                  {d}d
                </Link>
              ))}
            </div>
          </div>
        }
      />

      {t.runs === 0 ? (
        <EmptyState
          title="No live conversations yet"
          description="Publish a flow and chat with it through the widget. Test and eval runs are not counted."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Conversations" value={t.runs.toLocaleString()} sub={`last ${days} days`} />
            <Tile
              label="Handled without a person"
              value={pct(t.resolutionRate)}
              sub={`${t.resolved + t.converted} resolved or converted · ${t.escalated} escalated`}
            />
            <Tile
              label="Hours saved"
              value={a.roi.hoursSaved.toFixed(1)}
              sub={`at ${a.roi.baseline.minutesPerConversation} min per conversation`}
            />
            <Tile
              label="Net savings"
              value={money(a.roi.netSavingsUsd)}
              sub={`${money(a.roi.grossSavingsUsd)} saved − ${money(t.aiCostUsd)} AI cost`}
            />
          </div>
          {a.roi.baselineIsDefault && (
            <p className="mt-3 text-xs text-muted">
              Savings use a default baseline ({money(a.roi.baseline.costPerConversation)} and{" "}
              {a.roi.baseline.minutesPerConversation} minutes per human-handled conversation).{" "}
              {can(current, "admin") ? (
                <Link href="/settings#roi" className="text-accent hover:underline">
                  Set your own in Settings
                </Link>
              ) : (
                "An admin can set your own in Settings."
              )}
              . AI cost is tracked only for models with prices configured (LLM_PRICES_JSON).
            </p>
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <Card>
              <CardHeader title="Conversations per day" />
              <CardBody>
                <DailyChart daily={a.daily} days={days} />
              </CardBody>
            </Card>
            <div className="grid content-start gap-4">
              <Tile
                label="Customer satisfaction"
                value={t.csat == null ? "—" : `${Math.round(((t.csat - 1) / 4) * 100)}% 👍`}
                sub={`${t.feedbackCount} rating${t.feedbackCount === 1 ? "" : "s"} from the widget`}
              />
              <Tile label="Tokens used" value={t.tokens.toLocaleString()} sub={`AI cost ${money(t.aiCostUsd)}`} />
            </div>
          </div>

          <Card className="mt-6 overflow-x-auto">
            <CardHeader title="By flow" />
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-5 py-2 font-medium">Flow</th>
                  <th className="px-5 py-2 font-medium">Conversations</th>
                  <th className="px-5 py-2 font-medium">Automated</th>
                  <th className="px-5 py-2 font-medium">Escalated</th>
                  <th className="px-5 py-2 font-medium">Automation rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {a.byFlow.map((f) => (
                  <tr key={f.flowId}>
                    <td className="px-5 py-2">
                      <Link href={`/flows/${f.flowId}`} className="font-medium text-text hover:text-accent">
                        {f.name}
                      </Link>
                    </td>
                    <td className="px-5 py-2 tabular-nums text-text">{f.runs}</td>
                    <td className="px-5 py-2 tabular-nums text-text">{f.resolved}</td>
                    <td className="px-5 py-2 tabular-nums text-text">{f.escalated}</td>
                    <td className="px-5 py-2 tabular-nums text-text">{pct(f.runs ? f.resolved / f.runs : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {insights.clusters.length > 0 && (
        <Card className="mt-6">
          <CardHeader
            title="What customers ask about"
            description={`${insights.total} opening questions grouped by topic. Topics where conversations often fail, escalate or get a thumbs-down come with a suggested fix.`}
          />
          <ul className="divide-y divide-border">
            {insights.clusters.map((c) => (
              <li key={c.topic} className="px-5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-text">
                    “{c.topic}”{" "}
                    <span className="font-normal text-muted">
                      · {c.count} conversation{c.count === 1 ? "" : "s"}
                    </span>
                  </p>
                  <p className="text-xs tabular-nums text-muted">
                    {c.escalated} escalated · {c.failed} failed · {c.negative} 👎
                  </p>
                </div>
                <p className="mt-1 truncate text-xs text-muted">
                  e.g. {c.examples.map((e) => `“${e.message}”`).join(" · ")}
                </p>
                {c.suggestion && <p className="mt-1.5 text-xs text-warning">⚠ {c.suggestion}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
