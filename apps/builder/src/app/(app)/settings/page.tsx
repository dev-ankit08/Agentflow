import { Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { addProviderKey, cancelInvite, changeRole, deleteProviderKey, inviteMember, removeMember } from "../../actions";
import { saveWorkspaceSettings } from "../../actions-phase2";
import { deleteEndUser, indexKnowledgeNow, saveEmbedding, saveRetention } from "../../actions-phase3";

type WsSettings = {
  settings: {
    budget?: { monthlyUsd?: number; monthlyTokens?: number };
    roi?: { costPerConversation: number; minutesPerConversation: number };
    retention?: { days?: number; zeroRetention?: boolean };
  };
  usage: { usd: number; tokens: number };
  defaults: { roi: { costPerConversation: number; minutesPerConversation: number } };
};

type IndexStatus = { model: { provider: string; name: string } | null; total: number; indexed: number };

const embeddingProviders: Record<string, { label: string; model: string }> = {
  openai: { label: "OpenAI", model: "text-embedding-3-small" },
  azure_openai: { label: "Azure OpenAI", model: "your-embedding-deployment" },
  openai_compatible: { label: "OpenAI-compatible (Ollama, vLLM, mock)", model: "mock-embed" },
};

type EndUser = {
  endUserId: string;
  memories: { id: string; fact: string; createdAt: string }[];
  conversations: number;
};

type Member = { userId: string; email: string | null; name: string | null; role: string };
type Invite = { id: string; email: string; role: string };
type ProviderKey = { id: string; provider: string; label: string; maskedSecret: string; baseUrl: string | null };

const roleOptions = ["owner", "admin", "builder", "reviewer", "viewer"];
const providerLabels: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  azure_openai: "Azure OpenAI",
  openai_compatible: "OpenAI-compatible (Ollama, vLLM, …)",
  bedrock: "AWS Bedrock",
  vertex: "Google Vertex",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; endUser?: string }>;
}) {
  const { current, user } = await requireWorkspace();
  const isAdmin = can(current, "admin");
  const [{ members, invites }, keys, wsSettings] = await Promise.all([
    apiFetch<{ members: Member[]; invites: Invite[] }>("/v1/members", { workspaceId: current.id }),
    isAdmin ? apiFetch<{ keys: ProviderKey[] }>("/v1/provider-keys", { workspaceId: current.id }) : null,
    apiFetch<WsSettings>("/v1/workspace/settings", { workspaceId: current.id }),
  ]);
  const { error, ok, endUser: endUserQuery } = await searchParams;
  const endUser =
    isAdmin && endUserQuery?.trim()
      ? await apiFetch<EndUser>(`/v1/end-users/${encodeURIComponent(endUserQuery.trim())}`, { workspaceId: current.id })
      : null;
  const retention = wsSettings.settings.retention ?? {};
  const index = await apiFetch<IndexStatus>("/v1/knowledge/index", { workspaceId: current.id });

  return (
    <>
      <PageHeader title="Settings" description={`${current.orgName} / ${current.name}`} />
      <Flash error={error} ok={ok} />

      <div className="space-y-6">
        <Card>
          <CardHeader title="Members" description="Who can build, review and view flows in this workspace." />
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">
                    {m.name ?? m.email} {m.userId === user.id && <span className="text-muted">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-muted">{m.email}</p>
                </div>
                {isAdmin ? (
                  <div className="flex items-center gap-2">
                    <form action={changeRole} className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={m.userId} />
                      <label htmlFor={`role-${m.userId}`} className="sr-only">
                        Role
                      </label>
                      <Select id={`role-${m.userId}`} name="role" defaultValue={m.role} className="h-8 w-32">
                        {roleOptions.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" variant="secondary" size="sm">
                        Save
                      </Button>
                    </form>
                    <form action={removeMember}>
                      <input type="hidden" name="userId" value={m.userId} />
                      <Button type="submit" variant="danger" size="sm">
                        Remove
                      </Button>
                    </form>
                  </div>
                ) : (
                  <Badge>{m.role}</Badge>
                )}
              </li>
            ))}
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="text-sm text-text">{inv.email}</p>
                  <p className="text-xs text-muted">Invited as {inv.role} · joins on first sign-in</p>
                </div>
                {isAdmin && (
                  <form action={cancelInvite}>
                    <input type="hidden" name="id" value={inv.id} />
                    <Button type="submit" variant="ghost" size="sm">
                      Cancel
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {isAdmin && (
            <CardBody className="border-t border-border">
              <form action={inviteMember} className="grid gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end">
                <Field label="Invite by email" htmlFor="invite-email">
                  <Input id="invite-email" name="email" type="email" required placeholder="teammate@company.com" />
                </Field>
                <Field label="Role" htmlFor="invite-role">
                  <Select id="invite-role" name="role" defaultValue="builder">
                    {roleOptions
                      .filter((r) => r !== "owner" || current.role === "owner")
                      .map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Button type="submit">Invite</Button>
              </form>
            </CardBody>
          )}
        </Card>

        {keys && (
          <Card id="provider-keys">
            <CardHeader
              title="Model provider keys"
              description="Bring your own keys. They are encrypted at rest and never shown again after saving."
            />
            {keys.keys.length > 0 && (
              <ul className="divide-y divide-border">
                {keys.keys.map((k) => (
                  <li key={k.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">{k.label}</p>
                      <p className="truncate text-xs text-muted">
                        {providerLabels[k.provider] ?? k.provider} · <code>{k.maskedSecret}</code>
                        {k.baseUrl && ` · ${k.baseUrl}`}
                      </p>
                    </div>
                    <form action={deleteProviderKey}>
                      <input type="hidden" name="id" value={k.id} />
                      <Button type="submit" variant="danger" size="sm">
                        Delete
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <CardBody className={keys.keys.length > 0 ? "border-t border-border" : undefined}>
              <form action={addProviderKey} className="grid gap-3 sm:grid-cols-2">
                <Field label="Provider" htmlFor="provider">
                  <Select id="provider" name="provider" defaultValue="anthropic">
                    {Object.entries(providerLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Label" htmlFor="label">
                  <Input id="label" name="label" required maxLength={80} placeholder="Production" />
                </Field>
                <Field
                  label="API key"
                  htmlFor="secret"
                  hint="AWS Bedrock: a Bedrock API key, or ACCESS_KEY_ID:SECRET_ACCESS_KEY. Google Vertex: paste the service-account JSON key."
                >
                  <Input id="secret" name="secret" type="password" required autoComplete="off" />
                </Field>
                <Field
                  label="Base URL or region"
                  htmlFor="baseUrl"
                  hint="Azure OpenAI and OpenAI-compatible: endpoint URL (required). Bedrock: AWS region, e.g. us-east-1. Vertex: location, e.g. us-central1."
                >
                  <Input id="baseUrl" name="baseUrl" placeholder="https://… or us-east-1" />
                </Field>
                <div className="sm:col-span-2">
                  <Button type="submit">Save key</Button>
                </div>
              </form>
            </CardBody>
          </Card>
        )}

        <Card id="roi">
          <CardHeader
            title="Budget and ROI baseline"
            description={`This month so far: ${wsSettings.usage.tokens.toLocaleString()} tokens · $${wsSettings.usage.usd.toFixed(2)} (live runs only).`}
          />
          <CardBody>
            <form action={saveWorkspaceSettings} className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Monthly AI budget ($)"
                htmlFor="monthlyUsd"
                hint="Agents stop calling models when reached. Leave empty for no limit."
              >
                <Input
                  id="monthlyUsd"
                  name="monthlyUsd"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={wsSettings.settings.budget?.monthlyUsd ?? ""}
                  disabled={!isAdmin}
                />
              </Field>
              <Field
                label="Monthly token limit"
                htmlFor="monthlyTokens"
                hint="Useful when model prices aren't configured."
              >
                <Input
                  id="monthlyTokens"
                  name="monthlyTokens"
                  type="number"
                  min={0}
                  defaultValue={wsSettings.settings.budget?.monthlyTokens ?? ""}
                  disabled={!isAdmin}
                />
              </Field>
              <Field label="Cost of a human-handled conversation ($)" htmlFor="costPerConversation">
                <Input
                  id="costPerConversation"
                  name="costPerConversation"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={(wsSettings.settings.roi ?? wsSettings.defaults.roi).costPerConversation}
                  disabled={!isAdmin}
                />
              </Field>
              <Field label="Minutes a person spends per conversation" htmlFor="minutesPerConversation">
                <Input
                  id="minutesPerConversation"
                  name="minutesPerConversation"
                  type="number"
                  min={0}
                  step="0.5"
                  defaultValue={(wsSettings.settings.roi ?? wsSettings.defaults.roi).minutesPerConversation}
                  disabled={!isAdmin}
                />
              </Field>
              {isAdmin && (
                <div className="sm:col-span-2">
                  <Button type="submit">Save</Button>
                </div>
              )}
            </form>
          </CardBody>
        </Card>

        <Card id="semantic">
          <CardHeader
            title="Semantic knowledge search"
            description="Find passages by meaning, not just matching words. Knowledge nodes blend both kinds of match."
          />
          <CardBody className="space-y-4">
            <form action={saveEmbedding} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Embedding provider" htmlFor="emb-provider" hint="Uses that provider's key from Model keys.">
                <Select
                  id="emb-provider"
                  name="provider"
                  defaultValue={index.model?.provider ?? ""}
                  disabled={!isAdmin}
                >
                  <option value="">Off (word matching only)</option>
                  {Object.entries(embeddingProviders).map(([id, p]) => (
                    <option key={id} value={id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Embedding model"
                htmlFor="emb-name"
                hint="e.g. text-embedding-3-small, nomic-embed-text, mock-embed"
              >
                <Input
                  id="emb-name"
                  name="name"
                  defaultValue={index.model?.name ?? ""}
                  placeholder={embeddingProviders.openai!.model}
                  disabled={!isAdmin}
                />
              </Field>
              {isAdmin && <Button type="submit">Save</Button>}
            </form>
            {index.model && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 px-4 py-3 text-sm">
                <span className="text-text">
                  {index.indexed} of {index.total} passages indexed
                  {index.indexed < index.total && (
                    <span className="text-muted"> · the rest are indexed in the background within a minute</span>
                  )}
                </span>
                {isAdmin && index.indexed < index.total && (
                  <form action={indexKnowledgeNow}>
                    <Button type="submit" size="sm" variant="secondary">
                      Index now
                    </Button>
                  </form>
                )}
              </div>
            )}
          </CardBody>
        </Card>

        <Card id="privacy">
          <CardHeader
            title="Data retention"
            description="How long conversations and traces are kept. Applies to every flow in this workspace."
          />
          <CardBody>
            <form action={saveRetention} className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Delete conversations after (days)"
                htmlFor="days"
                hint="Leave empty to keep them until deleted. Checked hourly."
              >
                <Input
                  id="days"
                  name="days"
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={retention.days ?? ""}
                  disabled={!isAdmin}
                />
              </Field>
              <label className="flex items-start gap-2 pt-6 text-sm text-text">
                <input
                  type="checkbox"
                  name="zeroRetention"
                  defaultChecked={retention.zeroRetention}
                  disabled={!isAdmin}
                />
                <span>
                  Zero retention
                  <span className="block text-xs text-muted">
                    Never store prompts, tool data or transcripts. Traces keep only timings, tokens and cost; idle chats
                    are wiped after an hour.
                  </span>
                </span>
              </label>
              {isAdmin && (
                <div className="sm:col-span-2">
                  <Button type="submit">Save</Button>
                </div>
              )}
            </form>
          </CardBody>
        </Card>

        {isAdmin && (
          <Card id="end-users">
            <CardHeader
              title="Customer data requests"
              description="Look up what is stored about a customer (the user id from their identity token) and erase it on request."
            />
            <CardBody className="space-y-4">
              <form method="GET" action="/settings#end-users" className="flex gap-2">
                <Input name="endUser" placeholder="Customer id, e.g. cust_123" defaultValue={endUserQuery ?? ""} />
                <Button type="submit" variant="secondary">
                  Look up
                </Button>
              </form>
              {endUser && (
                <div className="space-y-3 rounded-lg border border-border p-4">
                  <p className="text-sm text-text">
                    <b className="font-mono">{endUser.endUserId}</b>: {endUser.conversations} conversation
                    {endUser.conversations === 1 ? "" : "s"}, {endUser.memories.length} remembered fact
                    {endUser.memories.length === 1 ? "" : "s"}.
                  </p>
                  {endUser.memories.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
                      {endUser.memories.map((m) => (
                        <li key={m.id}>{m.fact}</li>
                      ))}
                    </ul>
                  )}
                  {(endUser.conversations > 0 || endUser.memories.length > 0) && (
                    <form action={deleteEndUser}>
                      <input type="hidden" name="endUserId" value={endUser.endUserId} />
                      <Button type="submit" variant="danger" size="sm">
                        Erase all data for this customer
                      </Button>
                    </form>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
