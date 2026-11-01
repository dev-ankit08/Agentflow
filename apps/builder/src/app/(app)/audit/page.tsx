import { Alert, Card, EmptyState, PageHeader } from "@agentflow/ui";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";

type AuditEvent = {
  id: string;
  actorEmail: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
};

export default async function AuditPage() {
  const { current } = await requireWorkspace();
  if (!can(current, "admin")) {
    return (
      <>
        <PageHeader title="Audit log" />
        <Alert tone="accent">Only admins can view the audit log.</Alert>
      </>
    );
  }
  const { events } = await apiFetch<{ events: AuditEvent[] }>("/v1/audit?limit=200", { workspaceId: current.id });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every configuration change in this workspace: who did what, and when. Message content is never stored here."
        action={
          <a
            href="/api/v1/audit?format=csv"
            className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-2"
            download
          >
            Export CSV
          </a>
        }
      />
      {events.length === 0 ? (
        <EmptyState
          title="No changes recorded yet"
          description="Publishing, settings and member changes appear here."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-5 py-2 font-medium">When</th>
                <th className="px-5 py-2 font-medium">Who</th>
                <th className="px-5 py-2 font-medium">What</th>
                <th className="px-5 py-2 font-medium">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-5 py-2 text-xs tabular-nums text-muted">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="px-5 py-2 text-text">{e.actorEmail ?? e.actorId ?? "system"}</td>
                  <td className="px-5 py-2 font-medium text-text">{e.action}</td>
                  <td className="px-5 py-2 font-mono text-xs text-muted">
                    {e.targetType}
                    {e.targetId ? ` · ${e.targetId}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
