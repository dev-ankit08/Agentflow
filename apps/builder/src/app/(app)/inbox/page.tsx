import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";
import { approveRequest, closeHandoff, rejectRequest } from "../../actions-phase2";

type Approval = {
  id: string;
  runId: string;
  message: string;
  approverRole: string;
  expiresAt: string;
  createdAt: string;
  flowName: string;
  canDecide: boolean;
  conversation: { role: string; content: string }[];
};
type Handoff = { id: string; runId: string; queue: string; summary: string; createdAt: string; flowName: string };

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { current } = await requireWorkspace();
  const { approvals, handoffs } = await apiFetch<{ approvals: Approval[]; handoffs: Handoff[] }>("/v1/inbox", {
    workspaceId: current.id,
  });
  const { error, ok } = await searchParams;

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Requests waiting for a person: approvals that pause a conversation, and handoffs."
      />
      <Flash error={error} ok={ok} />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-text">Approvals ({approvals.length})</h2>
        {approvals.length === 0 ? (
          <EmptyState title="Nothing to approve" description="Approval nodes send their requests here." />
        ) : (
          <div className="space-y-4">
            {approvals.map((a) => (
              <Card key={a.id}>
                <CardHeader
                  title={a.message}
                  subtitle={`${a.flowName} · ${new Date(a.createdAt).toLocaleString()} · expires ${new Date(a.expiresAt).toLocaleString()}`}
                  action={<Badge tone="warning">{a.approverRole}+</Badge>}
                />
                <div className="space-y-2 px-5 py-3">
                  {a.conversation.map((t, i) => (
                    <p key={i} className="text-sm">
                      <span className="font-medium text-text">{t.role === "user" ? "Customer" : "Assistant"}:</span>{" "}
                      <span className="text-muted">{t.content}</span>
                    </p>
                  ))}
                  <Link href={`/runs/${a.runId}`} className="text-xs text-accent hover:underline">
                    Open full trace
                  </Link>
                </div>
                {a.canDecide ? (
                  <form
                    action={approveRequest}
                    className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3"
                  >
                    <input type="hidden" name="id" value={a.id} />
                    <label htmlFor={`note-${a.id}`} className="sr-only">
                      Note
                    </label>
                    <Input
                      id={`note-${a.id}`}
                      name="note"
                      placeholder="Note (optional)"
                      className="h-8 max-w-sm flex-1"
                    />
                    <Button type="submit" formAction={rejectRequest} variant="danger" size="sm">
                      Reject
                    </Button>
                    <Button type="submit" size="sm">
                      Approve
                    </Button>
                  </form>
                ) : (
                  <p className="border-t border-border px-5 py-3 text-xs text-muted">
                    Needs a {a.approverRole} or higher to decide.
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-text">Handoffs ({handoffs.length})</h2>
        {handoffs.length === 0 ? (
          <EmptyState title="No open handoffs" description="Handoff nodes pass conversations to your team here." />
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {handoffs.map((h) => (
                <li key={h.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">
                      {h.flowName} <Badge className="ml-1">{h.queue}</Badge>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{h.summary}</p>
                    <p className="mt-1 text-xs text-muted">
                      {new Date(h.createdAt).toLocaleString()} ·{" "}
                      <Link href={`/runs/${h.runId}`} className="text-accent hover:underline">
                        transcript
                      </Link>
                    </p>
                  </div>
                  <form action={closeHandoff}>
                    <input type="hidden" name="id" value={h.id} />
                    <Button type="submit" variant="secondary" size="sm">
                      Mark handled
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </>
  );
}
