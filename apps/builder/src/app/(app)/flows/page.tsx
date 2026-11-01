import Link from "next/link";
import { Badge, Button, Card, CardBody, EmptyState, Field, Input, PageHeader, Select } from "@agentflow/ui";
import { modelSuggestions, providerLabels } from "@/components/editor/model";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { createFlow } from "../../actions";
import { generateFlowFromDescription } from "../../actions-phase3";

type FlowRow = { id: string; name: string; liveVersionId: string | null; updatedAt: string };

export default async function FlowsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { current } = await requireWorkspace();
  const [{ flows }, { providers }] = await Promise.all([
    apiFetch<{ flows: FlowRow[] }>("/v1/flows", { workspaceId: current.id }),
    apiFetch<{ providers: string[] }>("/v1/providers", { workspaceId: current.id }),
  ]);
  const canEdit = can(current, "builder");
  const defaultProvider = (providers[0] ?? "anthropic") as keyof typeof modelSuggestions;

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
      {canEdit && (
        <Card className="mb-6">
          <details>
            <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-accent">
              ✦ Describe a flow and let AI draft it
            </summary>
            <CardBody className="border-t border-border">
              <form action={generateFlowFromDescription} className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-3">
                  <Field
                    label="What should it do?"
                    htmlFor="gen-description"
                    hint="Mention the steps, branches, data sources and when a person should step in. You can edit everything afterwards."
                  >
                    <textarea
                      id="gen-description"
                      name="description"
                      required
                      minLength={10}
                      maxLength={4000}
                      rows={4}
                      placeholder="e.g. Answer shipping questions from our help docs. If the customer wants a refund over $100, ask a team member to approve it first; otherwise confirm the refund."
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
                    />
                  </Field>
                </div>
                <Field label="Model for the draft and its agents" htmlFor="gen-provider">
                  <Select id="gen-provider" name="provider" defaultValue={defaultProvider}>
                    {Object.entries(providerLabels).map(([p, label]) => (
                      <option key={p} value={p}>
                        {label}
                        {providers.includes(p) ? " ✓" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Model name" htmlFor="gen-model">
                  <Input
                    id="gen-model"
                    name="model"
                    required
                    defaultValue={modelSuggestions[defaultProvider][0] ?? ""}
                  />
                </Field>
                <Field label="Flow name (optional)" htmlFor="gen-name">
                  <Input id="gen-name" name="name" maxLength={120} />
                </Field>
                <div className="sm:col-span-3">
                  <Button type="submit">Draft the flow</Button>
                  <span className="ml-3 text-xs text-muted">Takes a few seconds with a real model.</span>
                </div>
              </form>
            </CardBody>
          </details>
        </Card>
      )}
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
