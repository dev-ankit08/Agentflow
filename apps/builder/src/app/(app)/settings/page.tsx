import { Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { addProviderKey, cancelInvite, changeRole, deleteProviderKey, inviteMember, removeMember } from "../../actions";
import { saveWorkspaceSettings } from "../../actions-phase2";
import {
  deleteEndUser,
  deleteRole,
  saveRole,
  indexKnowledgeNow,
  saveEmbedding,
  saveCache,
  saveReports,
  sendTestReport,
  saveMemoryExtraction,
  saveNotifications,
  saveRetention,
} from "../../actions-phase3";

type WsSettings = {
  settings: {
    budget?: { monthlyUsd?: number; monthlyTokens?: number };
    roi?: { costPerConversation: number; minutesPerConversation: number };
    retention?: { days?: number; zeroRetention?: boolean };
    memoryExtraction?: { enabled: boolean; model: { provider: string; name: string }; idleMinutes: number };
    notifications?: { emailApprovers?: boolean; slackWebhookEnc?: string };
    cache?: { enabled: boolean; ttlHours: number; similar: boolean };
    reports?: { enabled: boolean; weekday: number; hourUtc: number; extraRecipients: string[]; lastSentAt?: string };
  };
  cache: { entries: number; hits: number };
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

type Member = {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
  customRoleId: string | null;
  customRole: string | null;
};
type CustomRole = { id: string; name: string; baseRole: string; permissions: string[]; members: number };
type Roles = {
  roles: CustomRole[];
  permissions: { id: string; label: string; preset: string }[];
  presets: Record<string, string[]>;
};
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

/** Name, base role and permission checkboxes; a new role starts from the reviewer preset. */
function RoleForm({ role, roles }: { role?: CustomRole; roles: Roles }) {
  const chosen = new Set(role?.permissions ?? roles.presets.reviewer ?? []);
  const key = role?.id ?? "new";
  return (
    <form action={saveRole} className="mt-3 space-y-3">
      {role && <input type="hidden" name="id" value={role.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${key}-role-name`}>
          <Input id={`${key}-role-name`} name="name" required maxLength={60} defaultValue={role?.name} />
        </Field>
        <Field
          label="Base role"
          htmlFor={`${key}-role-base`}
          hint="Applies to everything the permissions below don't cover (mostly viewing)."
        >
          <Select id={`${key}-role-base`} name="baseRole" defaultValue={role?.baseRole ?? "reviewer"}>
            {["viewer", "reviewer", "builder", "admin"].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="grid gap-1.5 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-medium text-muted">Permissions</legend>
        {roles.permissions.map((p) => (
          <label key={p.id} className="flex items-start gap-2 text-sm text-text">
            <input type="checkbox" name="permissions" value={p.id} defaultChecked={chosen.has(p.id)} className="mt-1" />
            <span>
              {p.label} <span className="text-xs text-muted">({p.preset}+)</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button type="submit" size="sm">
        {role ? "Save role" : "Create role"}
      </Button>
    </form>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; endUser?: string }>;
}) {
  const { current, user } = await requireWorkspace();
  const isAdmin = can(current, "admin");
  const [{ members, invites }, keys, wsSettings, roles] = await Promise.all([
    apiFetch<{ members: Member[]; invites: Invite[] }>("/v1/members", { workspaceId: current.id }),
    isAdmin ? apiFetch<{ keys: ProviderKey[] }>("/v1/provider-keys", { workspaceId: current.id }) : null,
    apiFetch<WsSettings>("/v1/workspace/settings", { workspaceId: current.id }),
    apiFetch<Roles>("/v1/roles", { workspaceId: current.id }),
  ]);
  const { error, ok, endUser: endUserQuery } = await searchParams;
  const endUser =
    isAdmin && endUserQuery?.trim()
      ? await apiFetch<EndUser>(`/v1/end-users/${encodeURIComponent(endUserQuery.trim())}`, { workspaceId: current.id })
      : null;
  const retention = wsSettings.settings.retention ?? {};
  const memory = wsSettings.settings.memoryExtraction;
  const notifications = wsSettings.settings.notifications ?? {};
  const cache = wsSettings.settings.cache;
  const reports = wsSettings.settings.reports;
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
                      <Select
                        id={`role-${m.userId}`}
                        name="role"
                        defaultValue={m.customRoleId ? `custom:${m.customRoleId}` : m.role}
                        className="h-8 w-44"
                      >
                        {roleOptions.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                        {roles.roles.length > 0 && (
                          <optgroup label="Custom roles">
                            {roles.roles.map((r) => (
                              <option key={r.id} value={`custom:${r.id}`}>
                                {r.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
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

        {isAdmin && (
          <Card id="roles">
            <CardHeader
              title="Custom roles"
              description="Fine-grained permission sets, e.g. a reviewer who can also read the audit log, or a builder who can't publish. Assign them in Members."
            />
            <CardBody className="space-y-4">
              {roles.roles.map((r) => (
                <details key={r.id} className="rounded-lg border border-border p-3">
                  <summary className="cursor-pointer text-sm text-text">
                    <b>{r.name}</b>{" "}
                    <span className="text-muted">
                      · based on {r.baseRole} · {r.permissions.length} permissions · {r.members} member
                      {r.members === 1 ? "" : "s"}
                    </span>
                  </summary>
                  <RoleForm role={r} roles={roles} />
                  <form action={deleteRole} className="mt-2">
                    <input type="hidden" name="id" value={r.id} />
                    <Button type="submit" variant="ghost" size="sm">
                      Delete role
                    </Button>
                  </form>
                </details>
              ))}
              <details className="rounded-lg border border-dashed border-border p-3" open={roles.roles.length === 0}>
                <summary className="cursor-pointer text-sm font-medium text-accent">New custom role</summary>
                <RoleForm roles={roles} />
              </details>
            </CardBody>
          </Card>
        )}

        <Card id="reports">
          <CardHeader
            title="Weekly report"
            description={`Email owners and admins a summary of the last 7 days: conversations, automation, hours and money saved.${reports?.lastSentAt ? ` Last sent ${new Date(reports.lastSentAt).toLocaleString()}.` : ""}`}
          />
          <CardBody className="space-y-3">
            <form action={saveReports} className="grid gap-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm text-text sm:col-span-3">
                <input type="checkbox" name="enabled" defaultChecked={reports?.enabled} disabled={!isAdmin} />
                Send the weekly report
              </label>
              <Field label="Day" htmlFor="report-day">
                <Select id="report-day" name="weekday" defaultValue={String(reports?.weekday ?? 1)} disabled={!isAdmin}>
                  {weekdays.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hour (UTC)" htmlFor="report-hour">
                <Input
                  id="report-hour"
                  name="hourUtc"
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={reports?.hourUtc ?? 8}
                  disabled={!isAdmin}
                />
              </Field>
              <Field label="Also send to" htmlFor="report-extra" hint="Comma-separated emails, e.g. your CFO.">
                <Input
                  id="report-extra"
                  name="extraRecipients"
                  defaultValue={(reports?.extraRecipients ?? []).join(", ")}
                  disabled={!isAdmin}
                />
              </Field>
              {isAdmin && (
                <div className="sm:col-span-3">
                  <Button type="submit">Save</Button>
                </div>
              )}
            </form>
            {isAdmin && (
              <form action={sendTestReport} className="flex items-center gap-2 text-xs text-muted">
                <Button type="submit" size="sm" variant="secondary">
                  Send me a test report
                </Button>
                Needs EMAIL_SERVER (SMTP) on the API.
              </form>
            )}
          </CardBody>
        </Card>

        <Card id="cache">
          <CardHeader
            title="Response cache"
            description={`Answer repeated questions instead of calling the model again: faster and free. ${wsSettings.cache.entries} cached answer${wsSettings.cache.entries === 1 ? "" : "s"}, reused ${wsSettings.cache.hits} time${wsSettings.cache.hits === 1 ? "" : "s"}.`}
          />
          <CardBody>
            <form action={saveCache} className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-sm text-text sm:col-span-2">
                <input type="checkbox" name="enabled" defaultChecked={cache?.enabled} disabled={!isAdmin} />
                <span>
                  Reuse answers to repeated questions
                  <span className="block text-xs text-muted">
                    Only for AI Agents without tools, and only when everything the agent saw matches (prompt, earlier
                    messages), so personalised answers aren&apos;t shared. Agents can opt out under Advanced; evals
                    never use it.
                  </span>
                </span>
              </label>
              <Field label="Keep answers for (hours)" htmlFor="cache-ttl">
                <Input
                  id="cache-ttl"
                  name="ttlHours"
                  type="number"
                  min={1}
                  max={720}
                  defaultValue={cache?.ttlHours ?? 24}
                  disabled={!isAdmin}
                />
              </Field>
              <label className="flex items-start gap-2 pt-6 text-sm text-text">
                <input type="checkbox" name="similar" defaultChecked={cache?.similar} disabled={!isAdmin} />
                <span>
                  Also match reworded questions
                  <span className="block text-xs text-muted">
                    Uses the embedding model from Semantic knowledge search.
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

        <Card id="notifications">
          <CardHeader
            title="Approval notifications"
            description="Tell people when a conversation is waiting for their approval."
          />
          <CardBody>
            <form action={saveNotifications} className="grid gap-3">
              <label className="flex items-start gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  name="emailApprovers"
                  defaultChecked={notifications.emailApprovers !== false}
                  disabled={!isAdmin}
                />
                <span>
                  Email everyone who can approve
                  <span className="block text-xs text-muted">
                    With one-click Approve and Reject links (each asks for confirmation, and they expire after 7 days).
                    Needs EMAIL_SERVER (SMTP) to be set on the API.
                  </span>
                </span>
              </label>
              <Field
                label="Slack channel (incoming webhook URL)"
                htmlFor="slackWebhookUrl"
                hint={
                  notifications.slackWebhookEnc
                    ? "A webhook is saved. Paste a new URL to replace it."
                    : "Create one under your Slack app → Incoming Webhooks. The message links to the Inbox."
                }
              >
                <Input
                  id="slackWebhookUrl"
                  name="slackWebhookUrl"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    notifications.slackWebhookEnc ? "•••••••• (saved)" : "https://hooks.slack.com/services/…"
                  }
                  disabled={!isAdmin}
                />
              </Field>
              {notifications.slackWebhookEnc && isAdmin && (
                <label className="flex items-center gap-2 text-sm text-text">
                  <input type="checkbox" name="removeSlack" /> Stop posting to Slack
                </label>
              )}
              {isAdmin && (
                <div>
                  <Button type="submit">Save</Button>
                </div>
              )}
            </form>
          </CardBody>
        </Card>

        <Card id="memory">
          <CardHeader
            title="Customer memory"
            description="Learn facts about signed-in customers from their conversations, so Memory nodes can recall them next time."
          />
          <CardBody>
            <form action={saveMemoryExtraction} className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-sm text-text sm:col-span-2">
                <input type="checkbox" name="enabled" defaultChecked={memory?.enabled} disabled={!isAdmin} />
                <span>
                  Learn from conversations in the background
                  <span className="block text-xs text-muted">
                    Only for customers signed in with an identity token. Facts are visible and erasable under Customer
                    data requests.
                  </span>
                </span>
              </label>
              <Field label="Provider" htmlFor="mem-provider">
                <Select
                  id="mem-provider"
                  name="provider"
                  defaultValue={memory?.model.provider ?? "openai_compatible"}
                  disabled={!isAdmin}
                >
                  {Object.entries(providerLabels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Model" htmlFor="mem-model" hint="A small, cheap model is enough.">
                <Input
                  id="mem-model"
                  name="model"
                  required
                  defaultValue={memory?.model.name ?? "mock-1"}
                  disabled={!isAdmin}
                />
              </Field>
              <Field
                label="Learn after a conversation is quiet for (minutes)"
                htmlFor="mem-idle"
                hint="It runs again if the customer comes back to the same conversation."
              >
                <Input
                  id="mem-idle"
                  name="idleMinutes"
                  type="number"
                  min={1}
                  max={1440}
                  defaultValue={memory?.idleMinutes ?? 30}
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
