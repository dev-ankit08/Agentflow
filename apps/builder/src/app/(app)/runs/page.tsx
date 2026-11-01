import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@agentflow/ui";
import { apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";
import { outcomeTone } from "@/lib/format";

type RunRow = {
  id: string;
  flowName: string;
  flowVersionId: string | null;
  status: string;
  outcome: string | null;
  firstMessage: string | null;
  turns: number;
  costUsd: string;
  startedAt: string;
};

export default async function RunsPage() {
  const { current } = await requireWorkspace();
  const { runs } = await apiFetch<{ runs: RunRow[] }>("/v1/runs?limit=100", { workspaceId: current.id });

  return (
    <>
      <PageHeader title="Runs & Traces" description="Every conversation and API run, step by step." />
      {runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="Test a flow in the editor or chat with a published widget to see traces here."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Flow</th>
                <th className="px-4 py-2 font-medium">First message</th>
                <th className="px-4 py-2 font-medium">Turns</th>
                <th className="px-4 py-2 font-medium">Outcome</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2">
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-muted">
                    <Link href={`/runs/${r.id}`} className="hover:text-accent">
                      {new Date(r.startedAt).toLocaleString()}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/runs/${r.id}`} className="font-medium text-text hover:text-accent">
                      {r.flowName}
                    </Link>
                    <span className="ml-2 text-[11px] text-muted">{r.flowVersionId ? "live" : "test"}</span>
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 text-muted">{r.firstMessage}</td>
                  <td className="px-4 py-2 text-muted">{r.turns}</td>
                  <td className="px-4 py-2">
                    {r.outcome ? <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge> : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">{r.status.replace("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
