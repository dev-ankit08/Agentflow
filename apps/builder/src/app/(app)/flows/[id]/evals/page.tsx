import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, PageHeader, cn } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { ApiError, apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { addCase, createDataset, deleteCase, runEvals, saveGate } from "../../../../actions-phase2";
import { importEvalCases } from "../../../../actions-phase3";

type Case = { id: string; input: string; expected: { contains?: string; outcome?: string; rubric?: string } };
type EvalRun = {
  id: string;
  passed: number;
  total: number;
  passRate: number | null;
  draftHash: string;
  createdAt: string;
  status: string;
};
type Dataset = { id: string; name: string; cases: Case[]; runs: EvalRun[] };
type Result = {
  id: string;
  input: string;
  reply: string | null;
  outcome: string | null;
  pass: boolean;
  latencyMs: number | null;
  runId: string | null;
  scores: { name: string; pass: boolean; score?: number; reason?: string }[];
};

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export default async function EvalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string; run?: string }>;
}) {
  const { current } = await requireWorkspace();
  const { id } = await params;
  const ws = { workspaceId: current.id };
  let flow: { name: string };
  try {
    flow = await apiFetch(`/v1/flows/${id}`, ws);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const data = await apiFetch<{
    datasets: Dataset[];
    draftHash: string;
    gate: { enabled: boolean; minPassRate: number };
  }>(`/v1/flows/${id}/evals`, ws);
  const { error, ok, run } = await searchParams;
  const runDetail = run
    ? await apiFetch<EvalRun & { results: Result[] }>(`/v1/eval-runs/${run}`, ws).catch(() => null)
    : null;
  const canEdit = can(current, "builder");

  return (
    <>
      <Link href={`/flows/${id}`} className="text-sm text-muted hover:text-text">
        ← Back to editor
      </Link>
      <PageHeader
        title={`Evals · ${flow.name}`}
        description="Test messages with expected results. Runs use the current draft in a sandbox: write tools are simulated and nothing reaches the Inbox."
      />
      <Flash error={error} ok={ok} />

      {runDetail && (
        <Card className="mb-6">
          <CardHeader
            title={`Latest run: ${runDetail.passed}/${runDetail.total} passed (${pct(runDetail.passRate)})`}
            action={
              <Badge tone={runDetail.passed === runDetail.total ? "success" : "danger"}>
                {runDetail.passed === runDetail.total ? "All passed" : "Failures"}
              </Badge>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Input</th>
                  <th className="px-4 py-2 font-medium">Reply</th>
                  <th className="px-4 py-2 font-medium">Checks</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runDetail.results.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="max-w-[200px] px-4 py-2 text-text">{r.input}</td>
                    <td className="max-w-[320px] px-4 py-2 text-xs text-muted">
                      {r.reply}
                      {r.outcome && <span className="mt-1 block">outcome: {r.outcome}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {r.scores.map((s) => (
                        <p key={s.name} className={s.pass ? "text-success" : "text-danger"}>
                          {s.pass ? "✓" : "✕"} {s.name}
                          {s.score != null && ` (${s.score}/5)`}
                          {s.reason && <span className="text-muted"> — {s.reason}</span>}
                        </p>
                      ))}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={r.pass ? "success" : "danger"}>{r.pass ? "pass" : "fail"}</Badge>
                      {r.runId && (
                        <Link href={`/runs/${r.runId}`} className="mt-1 block text-[11px] text-accent hover:underline">
                          trace
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          {data.datasets.length === 0 && (
            <EmptyState
              title="No eval datasets yet"
              description="Create a dataset, add test messages, then run it before publishing."
            />
          )}
          {data.datasets.map((ds) => {
            const latest = ds.runs[0];
            const stale = latest && latest.draftHash !== data.draftHash;
            return (
              <Card key={ds.id}>
                <CardHeader
                  title={ds.name}
                  subtitle={
                    latest
                      ? `Last run ${new Date(latest.createdAt).toLocaleString()}: ${latest.passed}/${latest.total} passed${stale ? " · draft changed since" : ""}`
                      : `${ds.cases.length} case(s), not run yet`
                  }
                  action={
                    canEdit && (
                      <form action={runEvals}>
                        <input type="hidden" name="flowId" value={id} />
                        <input type="hidden" name="datasetId" value={ds.id} />
                        <Button type="submit" size="sm" disabled={ds.cases.length === 0}>
                          Run evals
                        </Button>
                      </form>
                    )
                  }
                />
                <ul className="divide-y divide-border">
                  {ds.cases.map((c) => (
                    <li key={c.id} className="flex items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0 text-sm">
                        <p className="text-text">{c.input}</p>
                        <p className="text-xs text-muted">
                          {[
                            c.expected.contains && `mentions “${c.expected.contains}”`,
                            c.expected.outcome && `outcome ${c.expected.outcome}`,
                            c.expected.rubric && `judge: ${c.expected.rubric}`,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "must complete without errors"}
                        </p>
                      </div>
                      {canEdit && (
                        <form action={deleteCase}>
                          <input type="hidden" name="flowId" value={id} />
                          <input type="hidden" name="datasetId" value={ds.id} />
                          <input type="hidden" name="caseId" value={c.id} />
                          <Button type="submit" variant="ghost" size="sm" aria-label="Delete case">
                            ×
                          </Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
                {canEdit && (
                  <CardBody className="border-t border-border">
                    <form action={addCase} className="grid gap-2 sm:grid-cols-2">
                      <input type="hidden" name="flowId" value={id} />
                      <input type="hidden" name="datasetId" value={ds.id} />
                      <Input
                        name="input"
                        required
                        placeholder="Test message, e.g. I want a refund"
                        className="sm:col-span-2"
                        aria-label="Test message"
                      />
                      <Input
                        name="contains"
                        placeholder="Reply should mention… (optional)"
                        aria-label="Reply should mention"
                      />
                      <Input
                        name="outcome"
                        placeholder="Expected outcome: resolved / escalated…"
                        aria-label="Expected outcome"
                      />
                      <Input
                        name="rubric"
                        placeholder="Judge criteria (optional), e.g. polite and offers next steps"
                        className="sm:col-span-2"
                        aria-label="Judge criteria"
                      />
                      <div>
                        <Button type="submit" variant="secondary" size="sm">
                          + Add case
                        </Button>
                      </div>
                    </form>
                    <form
                      action={importEvalCases}
                      className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted"
                    >
                      <input type="hidden" name="flowId" value={id} />
                      <input type="hidden" name="datasetId" value={ds.id} />
                      <span>Or import many from CSV (columns: input, contains, outcome, rubric):</span>
                      <input
                        type="file"
                        name="file"
                        accept=".csv,text/csv"
                        required
                        aria-label="CSV file of test cases"
                        className="text-xs"
                      />
                      <Button type="submit" variant="secondary" size="sm">
                        Import
                      </Button>
                      <a
                        href={`/api/v1/evals/${ds.id}/cases.csv`}
                        className="ml-auto text-accent hover:underline"
                        download
                      >
                        Download cases as CSV
                      </a>
                    </form>
                  </CardBody>
                )}
              </Card>
            );
          })}
          {canEdit && (
            <form action={createDataset} className="flex gap-2">
              <input type="hidden" name="flowId" value={id} />
              <Input
                name="name"
                required
                placeholder="New dataset name"
                className="max-w-xs"
                aria-label="Dataset name"
              />
              <Button type="submit" variant="secondary">
                Create dataset
              </Button>
            </form>
          )}
        </div>

        <Card className="self-start">
          <CardHeader
            title="Publish gate"
            description="Block publishing unless the current draft passed its latest eval run."
          />
          <CardBody>
            <form action={saveGate} className="space-y-3">
              <input type="hidden" name="flowId" value={id} />
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={data.gate.enabled}
                  disabled={!can(current, "admin")}
                />
                Require evals before publishing
              </label>
              <label className="block text-sm text-text">
                Minimum pass rate (%)
                <Input
                  name="minPassRate"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={Math.round(data.gate.minPassRate * 100)}
                  disabled={!can(current, "admin")}
                  className={cn("mt-1 h-9 w-28")}
                />
              </label>
              {can(current, "admin") ? (
                <Button type="submit" size="sm">
                  Save
                </Button>
              ) : (
                <p className="text-xs text-muted">Admins can change the publish gate.</p>
              )}
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
