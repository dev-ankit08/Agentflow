"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, cn } from "@agentflow/ui";

type Step = {
  stepIndex: number;
  nodeId: string;
  label: string;
  nodeType: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  output?: unknown;
  error?: string;
  handle?: string;
  tokensIn?: number;
  tokensOut?: number;
};
type Citation = { n: number; title: string; uri: string | null };
type Line = { role: "user" | "bot" | "error" | "info"; text: string; citations?: Citation[] };
type FormUi = {
  title: string;
  submitLabel: string;
  fields: { name: string; label: string; type: string; options?: string[]; required: boolean }[];
};

async function* readEvents(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) yield JSON.parse(data) as Record<string, unknown> & { type: string };
    }
    if (done) return;
  }
}

/** A Form node's fields, as the end user would see them. */
function FormCard({
  form,
  disabled,
  onSubmit,
}: {
  form: FormUi;
  disabled: boolean;
  onSubmit: (values: Record<string, string>) => void;
}) {
  return (
    <form
      className="max-w-[85%] space-y-2 rounded-xl border border-accent/40 bg-accent-soft p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>);
      }}
    >
      <p className="text-xs font-medium text-text">{form.title}</p>
      {form.fields.map((f) => (
        <label key={f.name} className="block text-[11px] text-muted">
          {f.label}
          {f.required && " *"}
          {f.type === "select" ? (
            <select
              name={f.name}
              required={f.required}
              className="mt-0.5 block h-8 w-full rounded-md border border-border bg-surface px-2 text-xs text-text"
            >
              {(f.options ?? []).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              name={f.name}
              type={f.type === "number" ? "number" : f.type === "email" ? "email" : "text"}
              required={f.required}
              className="mt-0.5 block h-8 w-full rounded-md border border-border bg-surface px-2 text-xs text-text"
            />
          )}
        </label>
      ))}
      <Button type="submit" size="sm" disabled={disabled}>
        {form.submitLabel}
      </Button>
    </form>
  );
}

export function TestConsole({
  flowId,
  prepare,
  onStatus,
  onClose,
}: {
  flowId: string;
  /** Saves the draft and returns false if the flow has errors. */
  prepare: () => Promise<boolean>;
  onStatus: (statuses: Record<string, Step["status"]>) => void;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [userJson, setUserJson] = useState('{\n  "plan": "vip"\n}');
  const [showUser, setShowUser] = useState(false);
  const [form, setForm] = useState<FormUi | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const statuses = useRef<Record<string, Step["status"]>>({});
  const seenTurns = useRef(0);

  const scroll = () => requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));

  // How many conversation turns are on screen (user + bot lines mirror the run's conversation).
  useEffect(() => {
    seenTurns.current = lines.filter((l) => l.role === "user" || l.role === "bot").length;
  }, [lines]);

  // While a run waits for an approval in the Inbox, check for the reply every few seconds.
  useEffect(() => {
    if (!awaitingApproval || !runId) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/v1/runs/${runId}`).catch(() => null);
      if (!res?.ok) return;
      const run = (await res.json()) as {
        status: string;
        state: { conversation?: { role: string; content: string }[] };
      };
      if (run.status === "waiting_approval") return;
      const turns = run.state.conversation ?? [];
      const fresh = turns.slice(seenTurns.current).filter((t) => t.role === "assistant");
      setLines((l) => [
        ...l,
        { role: "info", text: "Approval decided in the Inbox." },
        ...fresh.map((t) => ({ role: "bot" as const, text: t.content })),
      ]);
      seenTurns.current = turns.length;
      setAwaitingApproval(false);
      scroll();
    }, 3000);
    return () => clearInterval(timer);
  }, [awaitingApproval, runId]);

  const reset = () => {
    setLines([]);
    setSteps([]);
    setRunId(null);
    setSelected(null);
    setForm(null);
    setAwaitingApproval(false);
    seenTurns.current = 0;
    statuses.current = {};
    onStatus({});
  };

  async function send(override?: { message: string; display: string }) {
    const message = override?.message ?? input.trim();
    if (!message || busy) return;
    let user: Record<string, unknown> = {};
    try {
      user = JSON.parse(userJson || "{}");
    } catch {
      setLines((l) => [...l, { role: "error", text: "Test user traits must be valid JSON" }]);
      return;
    }
    setBusy(true);
    setInput("");
    if (!runId && !(await prepare())) {
      setBusy(false);
      setLines((l) => [...l, { role: "error", text: "Fix the flow's errors (red badges) before testing." }]);
      return;
    }
    setLines((l) => [...l, { role: "user", text: override?.display ?? message }]);
    setForm(null);
    setSteps([]);
    statuses.current = {};
    onStatus({});
    scroll();

    try {
      const res = await fetch(runId ? `/api/v1/runs/${runId}/messages` : `/api/v1/flows/${flowId}/test-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runId ? { message } : { message, user }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.issues?.[0]?.message ?? body.error ?? `Request failed (${res.status})`);
      }
      let streamed = "";
      for await (const e of readEvents(res)) {
        switch (e.type) {
          case "run_started":
            setRunId(String(e.runId));
            break;
          case "step_started":
            statuses.current[String(e.nodeId)] = "running";
            onStatus({ ...statuses.current });
            setSteps((s) => [
              ...s,
              {
                stepIndex: Number(e.stepIndex),
                nodeId: String(e.nodeId),
                label: String(e.label),
                nodeType: String(e.nodeType),
                status: "running",
              },
            ]);
            break;
          case "token":
            streamed += String(e.text);
            setDraft(streamed);
            scroll();
            break;
          case "step_completed":
            statuses.current[String(e.nodeId)] = e.status as Step["status"];
            onStatus({ ...statuses.current });
            setSteps((s) =>
              s.map((st) =>
                st.stepIndex === e.stepIndex
                  ? {
                      ...st,
                      status: e.status as Step["status"],
                      durationMs: Number(e.durationMs),
                      output: e.output,
                      error: e.error as string | undefined,
                      handle: e.handle as string | undefined,
                      tokensIn: e.tokensIn as number | undefined,
                      tokensOut: e.tokensOut as number | undefined,
                    }
                  : st,
              ),
            );
            break;
          case "message":
            streamed = "";
            setDraft("");
            setLines((l) => [
              ...l,
              { role: "bot", text: String(e.content), citations: e.citations as Citation[] | undefined },
            ]);
            scroll();
            break;
          case "paused":
            if (e.reason === "form") setForm(e.ui as FormUi);
            else {
              setLines((l) => [...l, { role: "info", text: "Waiting for a team member to decide in the Inbox…" }]);
              setAwaitingApproval(true);
            }
            break;
          case "waiting_input":
          case "done":
            break;
          case "error":
            setDraft("");
            setLines((l) => [...l, { role: "error", text: String(e.message) }]);
            setRunId(null);
            break;
        }
      }
    } catch (error) {
      setLines((l) => [...l, { role: "error", text: (error as Error).message }]);
    } finally {
      setDraft("");
      setBusy(false);
    }
  }

  const step = steps.find((s) => s.stepIndex === selected);
  const totalTokens = steps.reduce((t, s) => t + (s.tokensIn ?? 0) + (s.tokensOut ?? 0), 0);

  return (
    <section aria-label="Test console" className="flex h-80 shrink-0 border-t border-border bg-surface">
      <div className="flex w-[42%] min-w-[320px] flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-xs font-semibold text-text">Test chat</p>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowUser((s) => !s)}
              title="Simulate a signed-in end user"
            >
              {"{{user}}"}
            </Button>
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              New chat
            </Button>
          </div>
        </div>
        {showUser && (
          <textarea
            aria-label="Test user traits (JSON)"
            value={userJson}
            onChange={(e) => setUserJson(e.target.value)}
            rows={3}
            className="border-b border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-text focus:outline-none"
          />
        )}
        <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite">
          {lines.length === 0 && !draft && (
            <p className="text-xs text-muted">Send a message to run the current draft.</p>
          )}
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-xs",
                l.role === "user" && "ml-auto bg-accent text-accent-fg",
                l.role === "bot" && "border border-border bg-surface-2 text-text",
                l.role === "error" && "mx-auto bg-danger/10 text-danger",
                l.role === "info" && "mx-auto bg-warning/10 text-warning",
              )}
            >
              {l.text}
              {l.citations?.length ? (
                <ol className="mt-2 space-y-0.5 border-t border-border pt-1.5 text-[10px] text-muted">
                  {l.citations.map((c) => (
                    <li key={c.n}>
                      [{c.n}]{" "}
                      {c.uri ? (
                        <a href={c.uri} target="_blank" rel="noopener noreferrer" className="underline">
                          {c.title}
                        </a>
                      ) : (
                        c.title
                      )}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ))}
          {draft && (
            <div className="max-w-[85%] whitespace-pre-wrap rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted">
              {draft}
            </div>
          )}
          {form && (
            <FormCard
              form={form}
              disabled={busy}
              onSubmit={(values) =>
                void send({ message: JSON.stringify(values), display: Object.values(values).join(", ") })
              }
            />
          )}
        </div>
        <form
          className="flex gap-2 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="test-input" className="sr-only">
            Test message
          </label>
          <input
            id="test-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={runId ? "Reply…" : "Try: Where is my order 1042?"}
            className="h-9 flex-1 rounded-lg border border-border bg-surface px-3 text-xs text-text focus:border-accent focus:outline-none"
          />
          <Button type="submit" size="sm" disabled={busy || !input.trim()}>
            {busy ? "Running…" : "Send"}
          </Button>
        </form>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-xs font-semibold text-text">
            Timeline {totalTokens ? <span className="font-normal text-muted">· {totalTokens} tokens</span> : null}
          </p>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close test console">
            ×
          </Button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ol className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
            {steps.map((s) => (
              <li key={s.stepIndex}>
                <button
                  type="button"
                  onClick={() => setSelected(s.stepIndex)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2",
                    selected === s.stepIndex && "bg-accent-soft",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        s.status === "ok" && "text-success",
                        s.status === "error" && "text-danger",
                        s.status === "running" && "text-warning",
                      )}
                    >
                      {s.status === "ok" ? "✓" : s.status === "error" ? "✕" : "…"}
                    </span>
                    <span className="truncate text-text">{s.label}</span>
                    {s.handle && <Badge className="!px-1 !py-0 !text-[9px]">{s.handle}</Badge>}
                  </span>
                  {s.durationMs !== undefined && (
                    <span className="shrink-0 text-[10px] text-muted">{s.durationMs} ms</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
          <div className="min-w-0 flex-1 overflow-auto p-3">
            {step ? (
              <>
                <p className="mb-2 text-xs text-muted">
                  {step.label} <code className="font-mono">({step.nodeId})</code>
                  {step.tokensIn !== undefined && ` · ${step.tokensIn} in / ${step.tokensOut} out tokens`}
                </p>
                {step.error && <p className="mb-2 text-xs text-danger">{step.error}</p>}
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-[11px] text-text">
                  {JSON.stringify(step.output ?? null, null, 2)}
                </pre>
              </>
            ) : (
              <p className="text-xs text-muted">Select a step to see its output and the variables it produced.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
