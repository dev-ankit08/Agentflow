import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, PageHeader } from "@agentflow/ui";
import type { FlowInput } from "@agentflow/flow-schema";
import { ApiError, apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";
import { promptChanges, promptFields, type DiffRow } from "@/lib/diff";

type Version = { id: string; version: number; status: string; json: FlowInput; createdAt: string };
type Change = { kind: "added" | "removed" | "changed"; label: string; detail: string[] };

/** Prompt text shown in the side-by-side diff instead of the field list. */
const PROMPT_KEYS = new Set(["systemPrompt", "userPrompt", "instructions", "task", "message", "pendingMessage"]);

/** Field-level differences between two node configs, as readable "field: before → after" lines. */
function configDiff(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!prefix && PROMPT_KEYS.has(key)) continue;
    const x = a[key];
    const y = b[key];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      out.push(...configDiff(x as Record<string, unknown>, y as Record<string, unknown>, `${prefix}${key}.`));
    } else {
      const show = (v: unknown) =>
        (v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v)).slice(0, 300);
      out.push(`${prefix}${key}: ${show(x)} → ${show(y)}`);
    }
  }
  return out;
}

function diffFlows(before: FlowInput | null, after: FlowInput): Change[] {
  const changes: Change[] = [];
  const old = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const now = new Map(after.nodes.map((n) => [n.id, n]));
  for (const n of after.nodes) {
    const prev = old.get(n.id);
    if (!prev) changes.push({ kind: "added", label: `${n.label} (${n.type})`, detail: [] });
    else {
      const detail = configDiff({ label: prev.label, ...prev.config }, { label: n.label, ...n.config });
      const promptEdited = JSON.stringify(promptFields(prev)) !== JSON.stringify(promptFields(n));
      if (promptEdited) detail.push("prompt text edited (see Prompt changes)");
      if (detail.length) changes.push({ kind: "changed", label: `${n.label} (${n.type})`, detail });
    }
  }
  for (const n of before?.nodes ?? [])
    if (!now.has(n.id)) changes.push({ kind: "removed", label: `${n.label} (${n.type})`, detail: [] });
  const edge = (e: FlowInput["edges"][number]) =>
    `${e.source}${e.sourceHandle ? `:${e.sourceHandle}` : ""} → ${e.target}`;
  const oldEdges = new Set((before?.edges ?? []).map(edge));
  const newEdges = new Set(after.edges.map(edge));
  for (const e of newEdges) if (!oldEdges.has(e)) changes.push({ kind: "added", label: `Connection ${e}`, detail: [] });
  for (const e of oldEdges)
    if (!newEdges.has(e)) changes.push({ kind: "removed", label: `Connection ${e}`, detail: [] });
  return changes;
}

const rowTone: Record<DiffRow["kind"], [string, string]> = {
  same: ["", ""],
  removed: ["bg-danger/10", ""],
  added: ["", "bg-success/10"],
  changed: ["bg-danger/10", "bg-success/10"],
};

function SideBySide({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border font-mono text-[11px]">
      {rows.map((r, i) => {
        const [l, rt] = rowTone[r.kind];
        const left = "left" in r ? r.left : "";
        const right = "right" in r ? r.right : "";
        return (
          <div key={i} className="contents">
            <div
              className={`min-h-[1.5em] whitespace-pre-wrap break-words border-r border-border px-2 py-0.5 text-text ${l}`}
            >
              {r.kind === "removed" || r.kind === "changed" ? (
                <span className="select-none text-danger">− </span>
              ) : null}
              {left}
            </div>
            <div className={`min-h-[1.5em] whitespace-pre-wrap break-words px-2 py-0.5 text-text ${rt}`}>
              {r.kind === "added" || r.kind === "changed" ? <span className="select-none text-success">+ </span> : null}
              {right}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; versionId: string }>;
  searchParams: Promise<{ against?: string }>;
}) {
  const { current } = await requireWorkspace();
  const { id, versionId } = await params;
  const ws = { workspaceId: current.id };
  let version: Version;
  try {
    version = await apiFetch<Version>(`/v1/flows/${id}/versions/${versionId}`, ws);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const { versions } = await apiFetch<{ versions: { id: string; version: number }[] }>(`/v1/flows/${id}/versions`, ws);
  const { against } = await searchParams;
  const previousMeta =
    versions.find((v) => v.id === against && v.id !== version.id) ??
    versions.find((v) => v.version === version.version - 1);
  const previous = previousMeta ? await apiFetch<Version>(`/v1/flows/${id}/versions/${previousMeta.id}`, ws) : null;
  const changes = diffFlows(previous?.json ?? null, version.json);
  const prompts = promptChanges(previous?.json ?? null, version.json);
  const others = versions.filter((v) => v.id !== version.id);
  const tone = { added: "success", removed: "danger", changed: "warning" } as const;

  return (
    <>
      <Link href={`/flows/${id}/deploy`} className="text-sm text-muted hover:text-text">
        ← Deploy
      </Link>
      <PageHeader
        title={`Version ${version.version}`}
        subtitle={`${previous ? `Changes since version ${previous.version}` : "First version"} · ${new Date(version.createdAt).toLocaleString()}`}
        action={<Badge>{version.status}</Badge>}
      />
      {others.length > 0 && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
          Compare with:
          {others.map((v) => (
            <Link
              key={v.id}
              href={`/flows/${id}/versions/${version.id}?against=${v.id}`}
              aria-current={v.id === previous?.id ? "true" : undefined}
              className={
                v.id === previous?.id
                  ? "rounded-md bg-accent-soft px-2 py-0.5 font-medium text-accent"
                  : "rounded-md px-2 py-0.5 hover:bg-surface-2 hover:text-text"
              }
            >
              v{v.version}
            </Link>
          ))}
        </p>
      )}
      {prompts.length > 0 && (
        <Card className="mb-6">
          <CardHeader
            title={`Prompt changes (${prompts.length})`}
            subtitle={
              previous
                ? `Version ${previous.version} on the left, version ${version.version} on the right.`
                : "New prompts in this version."
            }
          />
          <div className="space-y-5 px-5 pb-5">
            {prompts.map((p, i) => (
              <div key={i} className="space-y-1.5">
                <p className="text-sm font-medium text-text">
                  {p.node} · <span className="font-normal text-muted">{p.field}</span>
                </p>
                <SideBySide rows={p.rows} />
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <CardHeader title={`${changes.length} change${changes.length === 1 ? "" : "s"}`} />
        <ul className="divide-y divide-border">
          {changes.map((c, i) => (
            <li key={i} className="px-5 py-3">
              <p className="flex items-center gap-2 text-sm font-medium text-text">
                <Badge tone={tone[c.kind]}>{c.kind}</Badge>
                {c.label}
              </p>
              {c.detail.map((d, j) => (
                <p key={j} className="mt-1 whitespace-pre-wrap break-words pl-2 font-mono text-[11px] text-muted">
                  {d}
                </p>
              ))}
            </li>
          ))}
          {changes.length === 0 && <li className="px-5 py-3 text-sm text-muted">No changes.</li>}
        </ul>
      </Card>
    </>
  );
}
