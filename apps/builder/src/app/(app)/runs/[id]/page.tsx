import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Select } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { ApiError, apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { outcomeTone } from "@/lib/format";
import { addCaseFromRun } from "../../../actions-phase2";

type Step = {
  id: string;
  stepIndex: number;
  nodeId: string;
  nodeType: string;
  status: string;
  inputJson: unknown;
  outputJson: unknown;
  promptRedacted: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};
type RunDetail = {
  id: string;
  flowId: string;
  flowName: string;
  status: string;
  flowVersionId: string | null;
  endUserId: string | null;
  costUsd: string;
  startedAt: string;
  state: { outcome?: string; conversation?: { role: string; content: string }[]; user?: Record<string, unknown> };
  flow?: { nodes: { id: string; label: string }[] };
  steps: Step[];
};

const ms = (s: Step) => (s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : null);

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { current } = await requireWorkspace();
  const { id } = await params;
  let run: RunDetail;
  try {
    run = await apiFetch<RunDetail>(`/v1/runs/${id}`, { workspaceId: current.id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const { datasets } = await apiFetch<{ datasets: { id: string; name: string }[] }>(`/v1/flows/${run.flowId}/evals`, {
    workspaceId: current.id,
  });
  const { error, ok } = await searchParams;
  const labels = new Map(run.flow?.nodes.map((n) => [n.id, n.label]));
  const tokens = run.steps.reduce((t, s) => t + (s.tokensIn ?? 0) + (s.tokensOut ?? 0), 0);
  const cost = Number(run.costUsd);

  return (
    <>
      <Link href="/runs" className="text-sm text-muted hover:text-text">
        ← Runs
      </Link>
      <PageHeader
        title={run.flowName}
        description={`${run.flowVersionId ? "Live" : "Test"} run · ${new Date(run.startedAt).toLocaleString()} · ${run.steps.length} steps · ${tokens} tokens${cost ? ` · $${cost.toFixed(4)}` : ""}${run.endUserId ? ` · user ${run.endUserId}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            {run.state.outcome && <Badge tone={outcomeTone(run.state.outcome)}>{run.state.outcome}</Badge>}
            <Badge>{run.status.replace("_", " ")}</Badge>
            <Link href={`/flows/${run.flowId}`} className="text-sm text-accent hover:underline">
              Open flow
            </Link>
          </div>
        }
      />

      <Flash error={error} ok={ok} />
      {can(current, "builder") && datasets.length > 0 && (run.state.conversation ?? []).length > 0 && (
        <form action={addCaseFromRun} className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="runId" value={run.id} />
          <span className="text-muted">Keep this conversation as a test:</span>
          <label htmlFor="datasetId" className="sr-only">
            Eval dataset
          </label>
          <Select id="datasetId" name="datasetId" className="h-8 w-56">
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" size="sm">
            Add to eval dataset
          </Button>
        </form>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <Card>
          <CardHeader title="Conversation" />
          <CardBody className="space-y-2">
            {(run.state.conversation ?? []).map((t, i) => (
              <div
                key={i}
                className={
                  t.role === "user"
                    ? "ml-auto max-w-[85%] whitespace-pre-wrap rounded-xl bg-accent px-3 py-2 text-sm text-accent-fg"
                    : "max-w-[85%] whitespace-pre-wrap rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-text"
                }
              >
                {t.content}
              </div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Trace" description="Prompts are stored with personal data redacted." />
          <ol className="divide-y divide-border">
            {run.steps.map((s) => (
              <li key={s.id}>
                <details className="group px-5 py-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <span className={s.status === "ok" ? "text-success" : "text-danger"}>
                        {s.status === "ok" ? "✓" : "✕"}
                      </span>
                      <span className="truncate font-medium text-text">{labels.get(s.nodeId) ?? s.nodeId}</span>
                      <code className="text-[11px] text-muted">{s.nodeType}</code>
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {s.model && `${s.model} · `}
                      {s.tokensIn != null && `${s.tokensIn}/${s.tokensOut} tok · `}
                      {ms(s) ?? "?"} ms
                    </span>
                  </summary>
                  <div className="mt-3 space-y-2">
                    {s.error && <p className="text-sm text-danger">{s.error}</p>}
                    {s.promptRedacted && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted">Prompt sent</p>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-[11px] text-text">
                          {s.promptRedacted}
                        </pre>
                      </div>
                    )}
                    {s.inputJson != null && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted">Input</p>
                        <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] text-text">
                          {JSON.stringify(s.inputJson, null, 2)}
                        </pre>
                      </div>
                    )}
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted">Output</p>
                      <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] text-text">
                        {JSON.stringify(s.outputJson, null, 2)}
                      </pre>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
