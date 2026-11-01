import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { KnowledgeSearch } from "@/components/knowledge-search";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { addKnowledgeText, addKnowledgeUrl, deleteKnowledge, syncKnowledge } from "../../actions-phase2";

type Source = {
  id: string;
  name: string;
  type: "text" | "url";
  uri: string | null;
  status: string;
  error: string | null;
  lastSyncedAt: string | null;
  chunks: number;
};

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { current } = await requireWorkspace();
  const { sources } = await apiFetch<{ sources: Source[] }>("/v1/knowledge", { workspaceId: current.id });
  const canEdit = can(current, "builder");
  const { error, ok } = await searchParams;

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="Documents and web pages your agents can answer from. Add a Knowledge node to a flow to use them."
      />
      <Flash error={error} ok={ok} />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          {sources.length === 0 ? (
            <EmptyState title="No knowledge yet" description="Paste your FAQ or policies, or add a help-centre page." />
          ) : (
            <Card>
              <ul className="divide-y divide-border">
                {sources.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text">{s.name}</p>
                      <p className="truncate text-xs text-muted">
                        {s.type === "url" ? s.uri : "Pasted text"} · {s.chunks} passages
                        {s.lastSyncedAt && ` · synced ${new Date(s.lastSyncedAt).toLocaleString()}`}
                      </p>
                      {s.error && <p className="text-xs text-danger">{s.error}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={s.status === "error" ? "danger" : "success"}>{s.status}</Badge>
                      {canEdit && s.type === "url" && (
                        <form action={syncKnowledge}>
                          <input type="hidden" name="id" value={s.id} />
                          <Button type="submit" variant="secondary" size="sm">
                            Re-sync
                          </Button>
                        </form>
                      )}
                      {canEdit && (
                        <form action={deleteKnowledge}>
                          <input type="hidden" name="id" value={s.id} />
                          <Button type="submit" variant="danger" size="sm">
                            Delete
                          </Button>
                        </form>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {canEdit && (
            <Card>
              <CardHeader title="Add a document" description="Paste text such as an FAQ, policy or product guide." />
              <CardBody>
                <form action={addKnowledgeText} className="space-y-3">
                  <Field label="Name" htmlFor="k-name">
                    <Input id="k-name" name="name" required maxLength={120} placeholder="Returns policy" />
                  </Field>
                  <Field label="Content" htmlFor="k-content">
                    <textarea
                      id="k-content"
                      name="content"
                      required
                      rows={8}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
                      placeholder="Returns are accepted within 30 days of delivery…"
                    />
                  </Field>
                  <Button type="submit">Add document</Button>
                </form>
              </CardBody>
            </Card>
          )}

          {canEdit && (
            <Card>
              <CardHeader
                title="Add a web page"
                description="The page is fetched now; use Re-sync to pick up changes."
              />
              <CardBody>
                <form action={addKnowledgeUrl} className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
                  <Field label="Page URL" htmlFor="k-uri">
                    <Input id="k-uri" name="uri" type="url" required placeholder="https://help.example.com/returns" />
                  </Field>
                  <Field label="Name (optional)" htmlFor="k-uname">
                    <Input id="k-uname" name="name" maxLength={120} />
                  </Field>
                  <Button type="submit">Add page</Button>
                </form>
              </CardBody>
            </Card>
          )}
        </div>

        <Card className="self-start">
          <CardHeader title="Try a search" description="See which passages an agent would get for a question." />
          <CardBody>
            <KnowledgeSearch />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
