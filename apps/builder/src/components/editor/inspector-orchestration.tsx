"use client";

import { useEffect, useState } from "react";
import { nextCronRun, parseCron, type FlowInput, type NodeDef } from "@agentflow/flow-schema";
import { Button, Input, Select } from "@agentflow/ui";
import { FormulaField, ModelPicker, Row, TemplateField } from "./fields";
import { uniqueId } from "./model";

type Suggestions = { path: string; hint: string }[];

type Props = {
  node: NodeDef;
  onChange: (node: NodeDef) => void;
  suggestions: Suggestions;
  configuredProviders: string[];
  readOnly: boolean;
};

const idOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^([^a-z_])/, "w_$1") || "worker";

/** Settings for Supervisor, Parallel, Loop, Wait and Memory nodes. */
export function OrchestrationFields({ node, onChange, suggestions, configuredProviders, readOnly }: Props) {
  switch (node.type) {
    case "supervisor": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      const setWorker = (i: number, patch: Partial<(typeof node.config.workers)[number]>) =>
        set({ workers: node.config.workers.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
      return (
        <>
          <ModelPicker
            label="Supervisor model"
            value={node.config.model}
            configured={configuredProviders}
            disabled={readOnly}
            onChange={(model) => set({ model })}
          />
          <Row label="Instructions" hint="How the supervisor should plan, delegate and write the final answer.">
            <TemplateField
              value={node.config.instructions}
              rows={4}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(instructions) => set({ instructions })}
            />
          </Row>
          <Row label="Task">
            <TemplateField
              value={node.config.task}
              rows={2}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(task) => set({ task })}
            />
          </Row>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Specialists</p>
            {node.config.workers.map((w, i) => (
              <details key={i} className="rounded-lg border border-border p-2" open={i === 0}>
                <summary className="cursor-pointer text-xs font-medium text-text">
                  {w.name} <span className="font-mono text-muted">({w.id})</span>
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="grid grid-cols-2 gap-1">
                    <Input
                      value={w.name}
                      aria-label="Specialist name"
                      disabled={readOnly}
                      className="h-8 text-xs"
                      onChange={(e) => setWorker(i, { name: e.target.value })}
                    />
                    <Input
                      value={w.id}
                      aria-label="Specialist id"
                      disabled={readOnly}
                      className="h-8 font-mono text-xs"
                      onChange={(e) => setWorker(i, { id: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
                    />
                  </div>
                  <Row label="When to use" hint="The supervisor reads this to decide who to ask.">
                    <Input
                      value={w.description}
                      disabled={readOnly}
                      className="h-8 text-xs"
                      onChange={(e) => setWorker(i, { description: e.target.value })}
                    />
                  </Row>
                  <Row label="Specialist prompt">
                    <TemplateField
                      value={w.systemPrompt}
                      rows={3}
                      disabled={readOnly}
                      suggestions={suggestions}
                      onChange={(systemPrompt) => setWorker(i, { systemPrompt })}
                    />
                  </Row>
                  <label className="flex items-center gap-2 text-[11px] text-text">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={Boolean(w.model)}
                      onChange={(e) => setWorker(i, { model: e.target.checked ? { ...node.config.model } : undefined })}
                    />
                    Use a different model
                  </label>
                  {w.model && (
                    <ModelPicker
                      label="Specialist model"
                      value={w.model}
                      configured={configuredProviders}
                      disabled={readOnly}
                      onChange={(model) => setWorker(i, { model })}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={readOnly || node.config.workers.length === 1}
                    onClick={() => set({ workers: node.config.workers.filter((_, j) => j !== i) })}
                  >
                    Remove specialist
                  </Button>
                </div>
              </details>
            ))}
            {!readOnly && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const id = uniqueId(idOf("specialist"), new Set(node.config.workers.map((w) => w.id)));
                  set({
                    workers: [
                      ...node.config.workers,
                      {
                        id,
                        name: "Specialist",
                        description: "What this specialist is good at",
                        systemPrompt: "You are an expert.",
                      },
                    ],
                  });
                }}
              >
                + Add specialist
              </Button>
            )}
          </div>
          <Row label="Max delegation rounds" hint="After this many rounds the supervisor must answer.">
            <Input
              type="number"
              min={1}
              max={20}
              disabled={readOnly}
              className="h-8 text-xs"
              value={node.config.maxSteps}
              onChange={(e) => set({ maxSteps: Math.min(20, Math.max(1, Number(e.target.value) || 6)) })}
            />
          </Row>
          <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
            The answer is <code className="font-mono">{`{{${node.id}.text}}`}</code>; the specialists used are in{" "}
            <code className="font-mono">{`{{${node.id}.path}}`}</code>.
          </p>
        </>
      );
    }

    case "parallel": {
      const set = (tasks: typeof node.config.tasks) => onChange({ ...node, config: { ...node.config, tasks } });
      const setTask = (i: number, patch: Partial<(typeof node.config.tasks)[number]>) =>
        set(node.config.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)));
      return (
        <>
          <p className="text-[11px] text-muted">
            Every task runs at the same time; the flow continues when all have answered.
          </p>
          {node.config.tasks.map((t, i) => (
            <details key={i} className="rounded-lg border border-border p-2" open={i === 0}>
              <summary className="cursor-pointer text-xs font-medium text-text">
                {t.label} <span className="font-mono text-muted">({`{{${node.id}.${t.id}}}`})</span>
              </summary>
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-1">
                  <Input
                    value={t.label}
                    aria-label="Task label"
                    disabled={readOnly}
                    className="h-8 text-xs"
                    onChange={(e) => setTask(i, { label: e.target.value })}
                  />
                  <Input
                    value={t.id}
                    aria-label="Task id"
                    disabled={readOnly}
                    className="h-8 font-mono text-xs"
                    onChange={(e) => setTask(i, { id: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
                  />
                </div>
                <ModelPicker
                  label="Model"
                  value={t.model}
                  configured={configuredProviders}
                  disabled={readOnly}
                  onChange={(model) => setTask(i, { model })}
                />
                <Row label="System prompt">
                  <TemplateField
                    value={t.systemPrompt}
                    rows={3}
                    disabled={readOnly}
                    suggestions={suggestions}
                    onChange={(systemPrompt) => setTask(i, { systemPrompt })}
                  />
                </Row>
                <Row label="User message">
                  <TemplateField
                    value={t.userPrompt}
                    rows={2}
                    disabled={readOnly}
                    suggestions={suggestions}
                    onChange={(userPrompt) => setTask(i, { userPrompt })}
                  />
                </Row>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readOnly || node.config.tasks.length <= 2}
                  onClick={() => set(node.config.tasks.filter((_, j) => j !== i))}
                >
                  Remove task
                </Button>
              </div>
            </details>
          ))}
          {!readOnly && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const id = uniqueId("task", new Set(node.config.tasks.map((t) => t.id)));
                const last = node.config.tasks.at(-1)!;
                set([...node.config.tasks, { ...last, id, label: `Task ${node.config.tasks.length + 1}` }]);
              }}
            >
              + Add task
            </Button>
          )}
          <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
            <code className="font-mono">{`{{${node.id}.combined}}`}</code> has every answer under its label, ready to
            hand to a summarising agent.
          </p>
        </>
      );
    }

    case "loop": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      return (
        <>
          <Row label="List to loop over" hint="A formula that gives a list, e.g. orders.result.items.">
            <FormulaField
              value={node.config.items}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(items) => set({ items })}
            />
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Name each item">
              <Input
                value={node.config.itemVariable}
                disabled={readOnly}
                className="h-8 font-mono text-xs"
                onChange={(e) => set({ itemVariable: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") || "item" })}
              />
            </Row>
            <Row label="Max items">
              <Input
                type="number"
                min={1}
                max={500}
                disabled={readOnly}
                className="h-8 text-xs"
                value={node.config.maxIterations}
                onChange={(e) => set({ maxIterations: Math.min(500, Math.max(1, Number(e.target.value) || 20)) })}
              />
            </Row>
          </div>
          <Row
            label="Collect after each item (optional)"
            hint={`A formula; the values are gathered in {{${node.id}.results}}.`}
          >
            <FormulaField
              value={node.config.collect ?? ""}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(collect) => set({ collect: collect || undefined })}
            />
          </Row>
          <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
            Connect <b>each</b> to the steps to repeat, and the last of those steps back into this Loop. <b>done</b>{" "}
            continues once every item is processed.
          </p>
        </>
      );
    }

    case "wait": {
      const mode = node.config.until !== undefined ? "until" : "minutes";
      return (
        <>
          <Row label="Wait">
            <Select
              value={mode}
              disabled={readOnly}
              className="h-8 text-xs"
              onChange={(e) =>
                onChange({
                  ...node,
                  config: e.target.value === "until" ? { until: '"2026-12-01T09:00:00Z"' } : { minutes: 60 },
                })
              }
            >
              <option value="minutes">for a number of minutes</option>
              <option value="until">until a date and time</option>
            </Select>
          </Row>
          {mode === "minutes" ? (
            <Row label="Minutes" hint="1440 = one day. The run pauses and resumes automatically.">
              <Input
                type="number"
                min={0}
                max={43200}
                disabled={readOnly}
                className="h-8 text-xs"
                value={node.config.minutes ?? 0}
                onChange={(e) => onChange({ ...node, config: { minutes: Math.max(0, Number(e.target.value) || 0) } })}
              />
            </Row>
          ) : (
            <Row label="Until" hint="A formula giving an ISO date/time (UTC), e.g. a date from an earlier step.">
              <FormulaField
                value={node.config.until ?? ""}
                disabled={readOnly}
                suggestions={suggestions}
                onChange={(until) => onChange({ ...node, config: { until } })}
              />
            </Row>
          )}
          <p className="text-[11px] text-muted">
            Use waits in background flows (schedules, webhooks) or for follow-ups. A chat user sees the reply when the
            wait is over.
          </p>
        </>
      );
    }

    case "memory": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      return (
        <>
          <Row label="Mode">
            <Select
              value={node.config.mode}
              disabled={readOnly}
              className="h-8 text-xs"
              onChange={(e) => set({ mode: e.target.value as typeof node.config.mode })}
            >
              <option value="read">Recall facts about the customer</option>
              <option value="write">Save specific facts</option>
              <option value="extract">Learn facts from the conversation (AI)</option>
            </Select>
          </Row>
          {node.config.mode === "read" && (
            <>
              <Row label="Find facts related to" hint="A formula; the most relevant facts come first.">
                <FormulaField
                  value={node.config.query ?? "trigger.message"}
                  disabled={readOnly}
                  suggestions={suggestions}
                  onChange={(query) => set({ query })}
                />
              </Row>
              <Row label="Facts to recall">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  disabled={readOnly}
                  className="h-8 text-xs"
                  value={node.config.topK}
                  onChange={(e) => set({ topK: Math.min(20, Math.max(1, Number(e.target.value) || 5)) })}
                />
              </Row>
              <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
                Put <code className="font-mono">{`{{${node.id}.text}}`}</code> in an agent&apos;s prompt so it knows the
                customer.
              </p>
            </>
          )}
          {node.config.mode === "write" && (
            <Row
              label="Facts to save"
              hint='A formula giving text or a list, e.g. ["Prefers email"] or form.preference.'
            >
              <FormulaField
                value={node.config.facts ?? ""}
                disabled={readOnly}
                suggestions={suggestions}
                onChange={(facts) => set({ facts })}
              />
            </Row>
          )}
          {node.config.mode === "extract" && (
            <ModelPicker
              label="Model for extracting facts"
              value={node.config.model ?? { provider: "anthropic", name: "claude-haiku-5-5" }}
              configured={configuredProviders}
              disabled={readOnly}
              onChange={(model) => set({ model })}
            />
          )}
          <p className="text-[11px] text-muted">
            Memory needs a signed-in customer (an identity token on the widget). Anonymous visitors are skipped. Admins
            can view or erase a customer&apos;s data in Settings.
          </p>
        </>
      );
    }

    default:
      return null;
  }
}

const CRON_PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00 UTC", cron: "0 9 * * *" },
  { label: "Weekdays at 08:00 UTC", cron: "0 8 * * 1-5" },
  { label: "Mondays at 07:00 UTC", cron: "0 7 * * 1" },
];

/** Start node: how runs begin besides chat (schedule and webhook triggers). */
export function TriggersPanel({
  flowId,
  triggers,
  onChange,
  readOnly,
}: {
  flowId: string;
  triggers: FlowInput["triggers"];
  onChange: (triggers: NonNullable<FlowInput["triggers"]>) => void;
  readOnly: boolean;
}) {
  const list = triggers ?? [];
  const schedule = list.find((t) => t.type === "schedule");
  const cron = String(schedule?.config?.cron ?? "");
  const [inputText, setInputText] = useState(() => JSON.stringify(schedule?.config?.input ?? {}, null, 0));
  const [hook, setHook] = useState<{ url: string; signed: boolean } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/v1/flows/${flowId}/triggers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b && setHook(b.webhook));
  }, [flowId]);

  let preview: string;
  try {
    const next = cron ? nextCronRun(parseCron(cron), new Date()) : null;
    preview = next ? `Next run (once published): ${next.toUTCString()}` : "";
  } catch (e) {
    preview = (e as Error).message;
  }

  const setSchedule = (config: Record<string, unknown> | null) =>
    onChange([
      ...list.filter((t) => t.type !== "schedule"),
      ...(config ? [{ type: "schedule" as const, config }] : []),
    ]);

  async function createHook() {
    setHookError(null);
    const res = await fetch(`/api/v1/flows/${flowId}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setHookError(body.error ?? "Could not create the webhook");
    setHook({ url: body.url, signed: true });
    setSecret(body.secret);
  }
  async function removeHook() {
    const res = await fetch(`/api/v1/flows/${flowId}/webhook`, { method: "DELETE" });
    if (res.ok) {
      setHook(null);
      setSecret(null);
    } else setHookError("Only admins can remove the webhook");
  }

  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
        Runs for every chat message. The message is available as{" "}
        <code className="font-mono">{"{{trigger.message}}"}</code>, the signed-in end user as{" "}
        <code className="font-mono">{"{{user.*}}"}</code>.
      </p>

      <div className="space-y-2 rounded-lg border border-border p-2">
        <label className="flex items-center gap-2 text-xs font-medium text-text">
          <input
            type="checkbox"
            disabled={readOnly}
            checked={Boolean(schedule)}
            onChange={(e) => setSchedule(e.target.checked ? { cron: "0 9 * * *" } : null)}
          />
          Also run on a schedule
        </label>
        {schedule && (
          <>
            <Row label="Schedule (cron, UTC)" hint={preview}>
              <div className="flex gap-1">
                <Input
                  value={cron}
                  disabled={readOnly}
                  className="h-8 font-mono text-xs"
                  onChange={(e) => setSchedule({ ...schedule.config, cron: e.target.value })}
                />
                <Select
                  aria-label="Schedule presets"
                  disabled={readOnly}
                  className="h-8 w-28 text-xs"
                  value=""
                  onChange={(e) => e.target.value && setSchedule({ ...schedule.config, cron: e.target.value })}
                >
                  <option value="">Presets…</option>
                  {CRON_PRESETS.map((p) => (
                    <option key={p.cron} value={p.cron}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
            </Row>
            <Row label="Trigger input (JSON)" hint="Available as {{trigger.*}} in scheduled runs.">
              <Input
                value={inputText}
                disabled={readOnly}
                className="h-8 font-mono text-xs"
                onChange={(e) => {
                  setInputText(e.target.value);
                  try {
                    const input = JSON.parse(e.target.value || "{}");
                    if (input && typeof input === "object") setSchedule({ ...schedule.config, input });
                  } catch {
                    /* keep typing */
                  }
                }}
              />
            </Row>
          </>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-border p-2">
        <p className="text-xs font-medium text-text">Webhook</p>
        {hook ? (
          <>
            <Input readOnly value={hook.url} className="h-8 font-mono text-[11px]" onFocus={(e) => e.target.select()} />
            {secret && (
              <p className="rounded-md bg-warning/10 p-2 text-[11px] text-warning">
                Signing secret (shown once): <code className="break-all font-mono">{secret}</code>
              </p>
            )}
            <p className="text-[11px] text-muted">
              POST JSON to this address; the body becomes {"{{trigger.*}}"}. Sign it with header{" "}
              <code className="font-mono">x-agentflow-signature: sha256=&lt;HMAC of body&gt;</code>. Add{" "}
              <code className="font-mono">?wait=true</code> to get the result back.
            </p>
            {!readOnly && (
              <div className="flex gap-1">
                <Button variant="secondary" size="sm" onClick={createHook}>
                  Rotate
                </Button>
                <Button variant="ghost" size="sm" onClick={removeHook}>
                  Remove
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-[11px] text-muted">Let other systems (CRM, forms, Zapier) start this flow.</p>
            {!readOnly && (
              <Button variant="secondary" size="sm" onClick={createHook}>
                Create webhook URL
              </Button>
            )}
          </>
        )}
        {hookError && <p className="text-[11px] text-danger">{hookError}</p>}
      </div>
    </div>
  );
}

export type FlowComment = {
  id: string;
  nodeId: string;
  authorName: string;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
};

/** Comment thread for one node (review notes, questions for teammates). */
export function NodeComments({
  nodeId,
  comments,
  onAdd,
  onResolve,
  canComment,
}: {
  nodeId: string;
  comments: FlowComment[];
  onAdd: (nodeId: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  canComment: boolean;
}) {
  const [text, setText] = useState("");
  const mine = comments.filter((c) => c.nodeId === nodeId);
  return (
    <details className="rounded-lg border border-border p-2" open={mine.some((c) => !c.resolvedAt)}>
      <summary className="cursor-pointer text-xs font-medium text-text">
        Comments {mine.length ? `(${mine.filter((c) => !c.resolvedAt).length} open)` : ""}
      </summary>
      <div className="mt-2 space-y-2">
        {mine.map((c) => (
          <div key={c.id} className={c.resolvedAt ? "opacity-50" : ""}>
            <p className="text-[11px] text-text">
              <b>{c.authorName}</b> <span className="text-muted">{new Date(c.createdAt).toLocaleString()}</span>
            </p>
            <p className="whitespace-pre-wrap text-xs text-text">{c.body}</p>
            {canComment && (
              <button
                type="button"
                className="text-[11px] text-accent hover:underline"
                onClick={() => void onResolve(c.id, !c.resolvedAt)}
              >
                {c.resolvedAt ? "Reopen" : "Resolve"}
              </button>
            )}
          </div>
        ))}
        {canComment && (
          <form
            className="space-y-1"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              await onAdd(nodeId, text.trim());
              setText("");
            }}
          >
            <textarea
              value={text}
              rows={2}
              aria-label="New comment"
              placeholder="Leave a note for your team…"
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
            />
            <Button size="sm" type="submit" disabled={!text.trim()}>
              Comment
            </Button>
          </form>
        )}
      </div>
    </details>
  );
}
