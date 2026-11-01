import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@agentflow/ui";
import { apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";

type FlowRow = { id: string; name: string; liveVersionId: string | null };

/** Evals live with each flow; this page is the way in. */
export default async function EvalsIndex() {
  const { current } = await requireWorkspace();
  const { flows } = await apiFetch<{ flows: FlowRow[] }>("/v1/flows", { workspaceId: current.id });
  return (
    <>
      <PageHeader
        title="Evals"
        description="Test datasets and publish gates, per flow. Pick a flow to open its eval studio."
      />
      {flows.length === 0 ? (
        <EmptyState title="No flows yet" description="Create a flow first." />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {flows.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/flows/${f.id}/evals`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-surface-2"
                >
                  <span className="font-medium text-text">{f.name}</span>
                  <span className="text-sm text-accent">Open evals →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
