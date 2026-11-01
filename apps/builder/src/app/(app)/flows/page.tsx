import Link from "next/link";
import { Badge, Button, Card, EmptyState, Input, PageHeader } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { createFlow } from "../../actions";

type FlowRow = { id: string; name: string; liveVersionId: string | null; updatedAt: string };

export default async function FlowsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { current } = await requireWorkspace();
  const { flows } = await apiFetch<{ flows: FlowRow[] }>("/v1/flows", { workspaceId: current.id });
  const canEdit = can(current, "builder");

  const createForm = canEdit && (
    <form action={createFlow} className="flex gap-2">
      <label htmlFor="name" className="sr-only">
        Flow name
      </label>
      <Input id="name" name="name" required maxLength={120} placeholder="New flow name" className="w-56" />
      <Button type="submit">Create flow</Button>
    </form>
  );

  return (
    <>
      <PageHeader title="Flows" description="Multi-agent workflows in this workspace." action={createForm} />
      <Flash error={(await searchParams).error} />
      {flows.length === 0 ? (
        <EmptyState
          title="No flows yet"
          description={
            canEdit ? "Create your first flow to get started." : "Builders in this workspace can create flows."
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {flows.map((flow) => (
              <li key={flow.id}>
                <Link
                  href={`/flows/${flow.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">{flow.name}</p>
                    <p className="text-xs text-muted">Updated {new Date(flow.updatedAt).toLocaleString()}</p>
                  </div>
                  <Badge tone={flow.liveVersionId ? "success" : "neutral"}>
                    {flow.liveVersionId ? "Live" : "Draft"}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
