import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, PageHeader } from "@agentflow/ui";
import type { FlowInput } from "@agentflow/flow-schema";
import { ApiError, apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";

type Version = { id: string; version: number; status: string; json: FlowInput; createdAt: string };
type Change = { kind: "added" | "removed" | "changed"; label: string; detail: string[] };

/** Field-level differences between two node configs, as readable "field: before → after" lines. */
function configDiff(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
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

export default async function VersionPage({ params }: { params: Promise<{ id: string; versionId: string }> }) {
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
  const previousMeta = versions.find((v) => v.version === version.version - 1);
  const previous = previousMeta ? await apiFetch<Version>(`/v1/flows/${id}/versions/${previousMeta.id}`, ws) : null;
  const changes = diffFlows(previous?.json ?? null, version.json);
  const tone = { added: "success", removed: "danger", changed: "warning" } as const;

  return (
    <>
      <Link href={`/flows/${id}/deploy`} className="text-sm text-muted hover:text-text">
        ← Deploy
      </Link>
      <PageHeader
        title={`Version ${version.version}`}
        description={`${previous ? `Changes since version ${previous.version}` : "First version"} · ${new Date(version.createdAt).toLocaleString()}`}
        action={<Badge>{version.status}</Badge>}
      />
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
