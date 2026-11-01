"use client";

import { useState, type ReactNode } from "react";
import { Badge, InfoTip, cn } from "@agentflow/ui";

/** Mirrors the runtime's StepDebug (packages/runtime/src/debug.ts). */
export type PromptParts = {
  label?: string;
  system: string;
  context?: string;
  user: string;
  historyTurns: number;
  tools?: string[];
  cached?: boolean;
};
export type VarChange = { path: string; kind: "added" | "changed" | "removed"; before?: unknown; after?: unknown };
export type StepDebug = { before: Record<string, unknown>; changes: VarChange[]; prompts?: PromptParts[] };

export type DebuggableStep = {
  nodeId: string;
  label: string;
  nodeType?: string;
  status: string;
  durationMs?: number | null;
  output?: unknown;
  error?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  model?: string | null;
  debug?: StepDebug | null;
};

type Trace = { rule: string; matched: boolean; branch: string | null };
type Tab = "variables" | "prompt" | "rules" | "output" | "details";

const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const preview = (v: unknown) => {
  const text = JSON.stringify(v);
  return text === undefined ? "undefined" : text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

/** Context-rule traces from an AI step's output: one list for an agent, per specialist or task otherwise. */
function ruleGroups(output: unknown): { label: string; trace: Trace[] }[] {
  const rules = (output as { contextRules?: unknown } | null)?.contextRules;
  if (!rules) return [];
  if (Array.isArray(rules)) return [{ label: "", trace: rules as Trace[] }];
  const groups: { label: string; trace: Trace[] }[] = [];
  const r = rules as Record<string, unknown>;
  if (Array.isArray(r.supervisor)) groups.push({ label: "Supervisor", trace: r.supervisor as Trace[] });
  const nested = (r.workers ?? (Array.isArray(r.supervisor) ? {} : r)) as Record<string, unknown>;
  for (const [id, trace] of Object.entries(nested))
    if (Array.isArray(trace))
      groups.push({ label: r.workers ? `Specialist ${id}` : `Task ${id}`, trace: trace as Trace[] });
  return groups;
}

function Block({ title, tip, children }: { title: string; tip?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
        {tip && <InfoTip label={`About ${title}`}>{tip}</InfoTip>}
      </div>
      {children}
    </div>
  );
}

const pre =
  "max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] text-text";

/** The system prompt with the part chosen by context rules highlighted. */
function SystemText({ system, context }: { system: string; context?: string }) {
  const at = context ? system.indexOf(context) : -1;
  if (at < 0) return <pre className={pre}>{system || "(empty)"}</pre>;
  return (
    <pre className={pre}>
      {system.slice(0, at)}
      <mark className="rounded bg-accent-soft text-text">{context}</mark>
      {system.slice(at + context!.length)}
    </pre>
  );
}

function Variables({ debug }: { debug: StepDebug }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const changedRoots = new Set(debug.changes.map((c) => c.path.split(".")[0]));
  const entries = Object.entries(debug.before).filter(
    ([k, v]) => !q || k.toLowerCase().includes(q) || JSON.stringify(v)?.toLowerCase().includes(q),
  );
  return (
    <div className="space-y-3">
      <Block
        title="Changed by this step"
        tip="New outputs and variables this step set, compared with just before it ran."
      >
        {debug.changes.length === 0 ? (
          <p className="text-[11px] text-muted">Nothing changed.</p>
        ) : (
          <ul className="space-y-1">
            {debug.changes.map((c) => (
              <li key={c.path} className="rounded-md border border-border px-2 py-1 font-mono text-[11px]">
                <span
                  className={cn(
                    "mr-1.5 rounded px-1 text-[10px] font-semibold",
                    c.kind === "added" && "bg-success/15 text-success",
                    c.kind === "changed" && "bg-warning/15 text-warning",
                    c.kind === "removed" && "bg-danger/15 text-danger",
                  )}
                >
                  {c.kind === "added" ? "+" : c.kind === "changed" ? "~" : "−"}
                </span>
                <span className="text-text">{c.path}</span>
                {c.kind === "changed" && (
                  <span className="text-muted">
                    {" "}
                    <s>{preview(c.before)}</s> → <span className="text-text">{preview(c.after)}</span>
                  </span>
                )}
                {c.kind === "added" && <span className="text-muted"> = {preview(c.after)}</span>}
                {c.kind === "removed" && <s className="text-muted"> {preview(c.before)}</s>}
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block
        title="Values before this step"
        tip="Everything this step could read: flow variables, earlier steps' outputs (by node id), trigger and user. Long values are shortened and personal data is redacted."
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search variables…"
          aria-label="Search variables"
          className="mb-1.5 h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-text focus:border-accent focus:outline-none"
        />
        <ul className="space-y-0.5">
          {entries.map(([k, v]) => (
            <li key={k}>
              <details className="group rounded-md hover:bg-surface-2">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-1.5 py-1 font-mono text-[11px] [&::-webkit-details-marker]:hidden">
                  <span className="text-muted transition group-open:rotate-90">▸</span>
                  <span className="text-text">{k}</span>
                  {changedRoots.has(k) && (
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Changed by this step" />
                  )}
                  <span className="truncate text-muted">{preview(v)}</span>
                </summary>
                <pre className={cn(pre, "mx-1.5 mb-1.5")}>{json(v)}</pre>
              </details>
            </li>
          ))}
          {entries.length === 0 && <li className="text-[11px] text-muted">No variables match.</li>}
        </ul>
      </Block>
    </div>
  );
}

function Prompts({ prompts }: { prompts: PromptParts[] }) {
  return (
    <div className="space-y-4">
      {prompts.map((p, i) => (
        <div key={i} className={cn("space-y-2", prompts.length > 1 && "rounded-lg border border-border p-2")}>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            {p.label && <span className="font-semibold text-text">{p.label}</span>}
            {p.cached && <Badge tone="accent">answered from cache</Badge>}
            <span>
              {p.historyTurns} earlier turn{p.historyTurns === 1 ? "" : "s"} sent
            </span>
            {p.tools?.length ? <span>· tools: {p.tools.join(", ")}</span> : null}
          </div>
          {p.context !== undefined && (
            <Block
              title="Context chosen by rules"
              tip="The text your context rules picked for this run. It is part of the system prompt below (highlighted)."
            >
              {p.context ? (
                <pre className={pre}>{p.context}</pre>
              ) : (
                <p className="text-[11px] text-muted">No rule matched.</p>
              )}
            </Block>
          )}
          <Block
            title="System prompt"
            tip="Exactly what the model was told, after variables and context rules were filled in."
          >
            <SystemText system={p.system} context={p.context} />
          </Block>
          <Block title="User message">
            <pre className={pre}>{p.user || "(empty)"}</pre>
          </Block>
        </div>
      ))}
    </div>
  );
}

function Rules({ groups }: { groups: { label: string; trace: Trace[] }[] }) {
  return (
    <div className="space-y-3">
      {groups.map((g, i) => (
        <div key={i}>
          {g.label && <p className="mb-1 text-[11px] font-semibold text-text">{g.label}</p>}
          <ul className="space-y-0.5 font-mono text-[11px]">
            {g.trace.map((t, k) => (
              <li key={k} className={t.matched ? "text-success" : "text-muted"}>
                {t.matched ? "✓" : "✗"} rule {t.rule}
                {t.branch ? ` → ${t.branch}` : t.matched ? "" : " (not used)"}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Everything about one run step: the values it saw, what it changed, the prompts and context it sent, its output. */
export function StepDebugger({ step, compact }: { step: DebuggableStep; compact?: boolean }) {
  const prompts = step.debug?.prompts ?? [];
  const groups = ruleGroups(step.output);
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "prompt", label: prompts.length > 1 ? `Prompts (${prompts.length})` : "Prompt", show: prompts.length > 0 },
    { id: "variables", label: "Variables", show: Boolean(step.debug) },
    { id: "rules", label: "Context rules", show: groups.length > 0 },
    { id: "output", label: "Output", show: true },
    { id: "details", label: "Details", show: true },
  ];
  const visible = tabs.filter((t) => t.show);
  const [tab, setTab] = useState<Tab>(visible[0]!.id);
  const current = visible.some((t) => t.id === tab) ? tab : visible[0]!.id;

  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-xs text-muted">
          <span className="font-medium text-text">{step.label}</span> <code className="font-mono">({step.nodeId})</code>
          {step.durationMs != null && ` · ${step.durationMs} ms`}
          {step.tokensIn != null && ` · ${step.tokensIn} in / ${step.tokensOut ?? 0} out tokens`}
        </p>
      )}
      {step.error && <p className="rounded-md bg-danger/10 px-2 py-1 text-xs text-danger">{step.error}</p>}
      <div role="tablist" aria-label="Step details" className="flex flex-wrap gap-1 border-b border-border">
        {visible.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={current === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-2 py-1 text-[11px] font-medium",
              current === t.id ? "border-accent text-accent" : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {current === "variables" && step.debug && <Variables debug={step.debug} />}
        {current === "prompt" && <Prompts prompts={prompts} />}
        {current === "rules" && <Rules groups={groups} />}
        {current === "output" && (
          <pre className={cn(pre, "max-h-80")}>{JSON.stringify(step.output ?? null, null, 2)}</pre>
        )}
        {current === "details" && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            {(
              [
                ["Node", `${step.label} (${step.nodeId})`],
                ["Type", step.nodeType],
                ["Status", step.status],
                ["Model", step.model],
                ["Tokens", step.tokensIn != null ? `${step.tokensIn} in / ${step.tokensOut ?? 0} out` : null],
                ["Cost", step.costUsd != null ? `$${Number(step.costUsd).toFixed(6)}` : null],
                ["Duration", step.durationMs != null ? `${step.durationMs} ms` : null],
              ] as [string, string | null | undefined][]
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-text">{v}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>
      {!step.debug && (
        <p className="text-[11px] text-muted">
          No debug data for this step (it ran before debugging was added, or zero-retention mode is on).
        </p>
      )}
    </div>
  );
}
