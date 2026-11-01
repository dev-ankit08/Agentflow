import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader } from "@agentflow/ui";
import { ChannelsCard, type ChannelSummary } from "@/components/channels-card";
import { CopyBlock, IdentitySecret } from "@/components/deploy-tools";
import { Flash } from "@/components/flash";
import { ApiError, apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { rollbackVersion, saveWidget } from "../../../../actions";
import { approveReview, rejectReview, saveReviewSetting } from "../../../../actions-phase2";
import { promoteAbTest, startAbTest, stopAbTest } from "../../../../actions-phase3";

type Review = {
  id: string;
  status: string;
  versionId: string;
  version: number;
  requestedBy: string | null;
  createdAt: string;
};

type Widget = {
  widgetKey: string;
  liveVersionId: string | null;
  hasIdentitySecret: boolean;
  widget: { title: string; welcome: string; color: string; allowedOrigins: string[]; quickReplies: string[] };
};
type AbTest = {
  abTest: { versionId: string; percent: number; startedAt: string } | null;
  stats: {
    versionId: string;
    version: number | null;
    role: "live" | "challenger";
    conversations: number;
    resolved: number;
    escalated: number;
    failed: number;
    avgCostUsd: number;
    satisfaction: number | null;
  }[];
};
type Versions = { versions: { id: string; version: number; status: string; createdAt: string }[] };

export default async function DeployPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { current } = await requireWorkspace();
  const { id } = await params;
  let flow: { id: string; name: string; settings: { requireReview?: boolean } };
  try {
    flow = await apiFetch(`/v1/flows/${id}`, { workspaceId: current.id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const [w, { versions }, { reviews }, { channels }, ab] = await Promise.all([
    apiFetch<Widget>(`/v1/flows/${id}/widget`, { workspaceId: current.id }),
    apiFetch<Versions>(`/v1/flows/${id}/versions`, { workspaceId: current.id }),
    apiFetch<{ reviews: Review[] }>(`/v1/flows/${id}/reviews`, { workspaceId: current.id }),
    apiFetch<{ channels: ChannelSummary[] }>(`/v1/channels?flowId=${id}`, { workspaceId: current.id }),
    apiFetch<AbTest>(`/v1/flows/${id}/ab-test`, { workspaceId: current.id }),
  ]);
  const pendingReviews = reviews.filter((r) => r.status === "pending");
  const { error, ok } = await searchParams;
  const canEdit = can(current, "builder");
  const apiUrl = process.env.PUBLIC_API_URL ?? process.env.API_URL ?? "http://localhost:4000";
  const snippet = `<script src="${apiUrl}/widget.js" data-flow="${w.widgetKey}" async></script>`;
  const inline = `<div id="assistant" style="height:600px"></div>\n<script src="${apiUrl}/widget.js" data-flow="${w.widgetKey}" data-mode="inline" data-target="#assistant" async></script>`;
  const live = versions.find((v) => v.status === "live");

  return (
    <>
      <Link href={`/flows/${id}`} className="text-sm text-muted hover:text-text">
        ← Back to editor
      </Link>
      <PageHeader
        title={`Deploy · ${flow.name}`}
        description="Publish from the editor, then embed the agent on any website."
        action={<Badge tone={live ? "success" : "neutral"}>{live ? `Live v${live.version}` : "Not published"}</Badge>}
      />
      <Flash error={error} ok={ok} />
      {!live && (
        <div className="mb-6">
          <Alert tone="accent">
            This flow is not published yet. Open the editor and click Publish — the widget only serves live versions.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Embed on your website"
              description="Paste before </body>. Works on any site; the widget is isolated from your page's CSS."
              action={
                live && (
                  <Link
                    href={`/preview/${w.widgetKey}`}
                    target="_blank"
                    className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-2"
                  >
                    Live preview ↗
                  </Link>
                )
              }
            />
            <CardBody className="space-y-4">
              <CopyBlock code={snippet} />
              <details>
                <summary className="cursor-pointer text-sm text-accent">Inline instead of a chat bubble</summary>
                <div className="mt-2">
                  <CopyBlock code={inline} />
                </div>
              </details>
              <details>
                <summary className="cursor-pointer text-sm text-accent">JavaScript API and REST</summary>
                <div className="mt-2 space-y-2 text-sm text-muted">
                  <CopyBlock
                    code={`AgentFlow.open();\nAgentFlow.send("Where is my order?");\nAgentFlow.identify(signedJwt);\nAgentFlow.on("message", (m) => console.log(m.content));`}
                  />
                  <p>
                    Server-to-server:{" "}
                    <code className="font-mono">
                      POST {apiUrl}/v1/widget/{w.widgetKey}/sessions
                    </code>{" "}
                    with <code className="font-mono">{'{"message": "…"}'}</code> streams server-sent events.
                  </p>
                </div>
              </details>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Appearance and security" />
            <CardBody>
              <form action={saveWidget} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="flowId" value={id} />
                <Field label="Title" htmlFor="title">
                  <Input
                    id="title"
                    name="title"
                    required
                    maxLength={60}
                    defaultValue={w.widget.title}
                    disabled={!canEdit}
                  />
                </Field>
                <Field label="Brand colour" htmlFor="color">
                  <Input
                    id="color"
                    name="color"
                    type="color"
                    defaultValue={w.widget.color}
                    className="h-10 p-1"
                    disabled={!canEdit}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Welcome message" htmlFor="welcome">
                    <Input
                      id="welcome"
                      name="welcome"
                      maxLength={300}
                      defaultValue={w.widget.welcome}
                      disabled={!canEdit}
                    />
                  </Field>
                </div>
                <Field label="Quick replies (one per line)" htmlFor="quickReplies">
                  <textarea
                    id="quickReplies"
                    name="quickReplies"
                    rows={3}
                    defaultValue={w.widget.quickReplies.join("\n")}
                    disabled={!canEdit}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
                  />
                </Field>
                <Field
                  label="Allowed websites (one origin per line)"
                  htmlFor="allowedOrigins"
                  hint="e.g. https://www.example.com. While empty, only localhost pages can use the widget."
                >
                  <textarea
                    id="allowedOrigins"
                    name="allowedOrigins"
                    rows={3}
                    defaultValue={w.widget.allowedOrigins.join("\n")}
                    disabled={!canEdit}
                    placeholder="https://www.example.com"
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text focus:border-accent focus:outline-none"
                  />
                </Field>
                {canEdit && (
                  <div className="sm:col-span-2">
                    <Button type="submit">Save settings</Button>
                  </div>
                )}
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Signed-in users (optional)" />
            <CardBody>
              <IdentitySecret flowId={id} exists={w.hasIdentitySecret} canManage={can(current, "admin")} />
            </CardBody>
          </Card>

          <ChannelsCard flowId={id} channels={channels} canManage={can(current, "admin")} live={Boolean(live)} />

          <Card>
            <CardHeader
              title="A/B test"
              description="Send a share of new conversations to another version and compare how each performs."
            />
            <CardBody className="space-y-4">
              {ab.abTest ? (
                <>
                  <p className="text-sm text-text">
                    {ab.abTest.percent}% of new conversations use the challenger, since{" "}
                    {new Date(ab.abTest.startedAt).toLocaleString()}.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted">
                          <th className="py-2 pr-3 font-medium">Version</th>
                          <th className="py-2 pr-3 font-medium">Conversations</th>
                          <th className="py-2 pr-3 font-medium">Automated</th>
                          <th className="py-2 pr-3 font-medium">Escalated</th>
                          <th className="py-2 pr-3 font-medium">Satisfaction</th>
                          <th className="py-2 font-medium">Avg cost</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {ab.stats.map((s) => (
                          <tr key={s.versionId}>
                            <td className="py-2 pr-3 text-text">
                              v{s.version} <Badge tone={s.role === "live" ? "success" : "accent"}>{s.role}</Badge>
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-text">{s.conversations}</td>
                            <td className="py-2 pr-3 tabular-nums text-text">
                              {s.conversations ? `${Math.round((s.resolved / s.conversations) * 100)}%` : "—"}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-text">
                              {s.conversations ? `${Math.round((s.escalated / s.conversations) * 100)}%` : "—"}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-text">
                              {s.satisfaction == null ? "—" : `${Math.round(s.satisfaction * 100)}%`}
                            </td>
                            <td className="py-2 tabular-nums text-text">${s.avgCostUsd.toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {can(current, "admin") && (
                    <div className="flex gap-2">
                      <form action={promoteAbTest}>
                        <input type="hidden" name="flowId" value={id} />
                        <Button type="submit" size="sm">
                          Make challenger live
                        </Button>
                      </form>
                      <form action={stopAbTest}>
                        <input type="hidden" name="flowId" value={id} />
                        <Button type="submit" size="sm" variant="secondary">
                          Stop test
                        </Button>
                      </form>
                    </div>
                  )}
                </>
              ) : !live ? (
                <p className="text-sm text-muted">Publish the flow first.</p>
              ) : versions.filter((v) => v.id !== live.id).length === 0 ? (
                <p className="text-sm text-muted">Publish another version to test it against the live one.</p>
              ) : can(current, "admin") ? (
                <form action={startAbTest} className="grid gap-3 sm:grid-cols-[1fr_120px_auto] sm:items-end">
                  <input type="hidden" name="flowId" value={id} />
                  <Field label="Challenger version" htmlFor="versionId">
                    <select
                      id="versionId"
                      name="versionId"
                      className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm text-text"
                    >
                      {versions
                        .filter((v) => v.id !== live.id)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.version} ({v.status})
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Traffic %" htmlFor="percent">
                    <Input id="percent" name="percent" type="number" min={1} max={90} defaultValue={20} />
                  </Field>
                  <Button type="submit">Start test</Button>
                </form>
              ) : (
                <p className="text-sm text-muted">An admin can start an A/B test.</p>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6 self-start">
          <Card>
            <CardHeader
              title="Review before live"
              description="When on, Publish puts the version in review; a reviewer makes it live."
            />
            <CardBody className="space-y-3">
              <form action={saveReviewSetting} className="flex items-center justify-between gap-2">
                <input type="hidden" name="flowId" value={id} />
                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    name="requireReview"
                    defaultChecked={Boolean(flow.settings.requireReview)}
                    disabled={!can(current, "admin")}
                  />
                  Require a review
                </label>
                {can(current, "admin") && (
                  <Button type="submit" variant="secondary" size="sm">
                    Save
                  </Button>
                )}
              </form>
              {pendingReviews.map((r) => (
                <div key={r.id} className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <p className="text-sm font-medium text-text">
                    Version {r.version} is waiting for review
                    <span className="block text-xs font-normal text-muted">
                      requested by {r.requestedBy ?? "unknown"} · {new Date(r.createdAt).toLocaleString()} ·{" "}
                      <Link href={`/flows/${id}/versions/${r.versionId}`} className="text-accent hover:underline">
                        see changes
                      </Link>
                    </span>
                  </p>
                  {can(current, "reviewer") && (
                    <form action={approveReview} className="mt-2 flex gap-2">
                      <input type="hidden" name="flowId" value={id} />
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" formAction={rejectReview} variant="danger" size="sm">
                        Reject
                      </Button>
                      <Button type="submit" size="sm">
                        Approve and go live
                      </Button>
                    </form>
                  )}
                </div>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Versions" description="Each publish is an immutable snapshot." />
            {versions.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted">No versions yet.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div>
                      <p className="text-sm font-medium text-text">Version {v.version}</p>
                      <p className="text-xs text-muted">
                        {new Date(v.createdAt).toLocaleString()} ·{" "}
                        <Link href={`/flows/${id}/versions/${v.id}`} className="text-accent hover:underline">
                          changes
                        </Link>
                      </p>
                    </div>
                    {v.status === "live" ? (
                      <Badge tone="success">Live</Badge>
                    ) : v.status === "staging" ? (
                      <Badge tone="warning">In review</Badge>
                    ) : (
                      canEdit && (
                        <form action={rollbackVersion}>
                          <input type="hidden" name="flowId" value={id} />
                          <input type="hidden" name="versionId" value={v.id} />
                          <Button type="submit" variant="secondary" size="sm">
                            Roll back
                          </Button>
                        </form>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
