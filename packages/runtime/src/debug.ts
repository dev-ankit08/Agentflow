import type { RunState } from "./types";

/** One AI call as it was assembled: the context-rule block is shown on its own as well as inside `system`. */
export type PromptParts = {
  /** Which call, for steps that make several (e.g. "supervisor", "specialist: billing", "task: summary"). */
  label?: string;
  system: string;
  /** Text chosen by context rules (already part of `system`). */
  context?: string;
  user: string;
  /** Earlier conversation turns sent along with the prompt. */
  historyTurns: number;
  /** Tools the model was allowed to call. */
  tools?: string[];
  /** Answered from the response cache, without calling the model. */
  cached?: boolean;
};

export type VarChange = { path: string; kind: "added" | "changed" | "removed"; before?: unknown; after?: unknown };

/** Recorded per step so builders can debug a run: what the step could read, what it changed, and what it sent. */
export type StepDebug = {
  /** Variables, earlier steps' outputs, trigger and user just before the step ran (long values shortened). */
  before: Record<string, unknown>;
  changes: VarChange[];
  prompts?: PromptParts[];
};

const MAX_TEXT = 2_000;
const MAX_ITEMS = 20;
const MAX_KEYS = 50;
const MAX_DEPTH = 5;
const MAX_CHANGES = 100;

/** A detached copy that keeps traces small: long text, big lists and deep objects are shortened. */
export function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.length > MAX_TEXT
      ? `${value.slice(0, MAX_TEXT)}… (${value.length - MAX_TEXT} more characters)`
      : value;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map((v) => compact(v, depth + 1));
    return value.length > MAX_ITEMS ? [...head, `… ${value.length - MAX_ITEMS} more items`] : head;
  }
  const entries = Object.entries(value);
  const out = Object.fromEntries(entries.slice(0, MAX_KEYS).map(([k, v]) => [k, compact(v, depth + 1)]));
  if (entries.length > MAX_KEYS) out["…"] = `${entries.length - MAX_KEYS} more keys`;
  return out;
}

/** What a step can read, as formulas and templates see it (the conversation is summarised, not copied). */
export function snapshotScope(state: RunState): Record<string, unknown> {
  return compact({
    ...state.variables,
    ...state.nodeOutputs,
    trigger: state.trigger,
    user: state.user,
    conversation: {
      turn: state.conversation.filter((t) => t.role === "user").length,
      messages: state.conversation.length,
    },
  }) as Record<string, unknown>;
}

const isPlain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Differences between two snapshots. New or removed keys are reported whole (a step's new output is one "added"
 * entry); objects present on both sides are compared key by key a few levels deep.
 */
export function diffScope(before: Record<string, unknown>, after: Record<string, unknown>): VarChange[] {
  const changes: VarChange[] = [];
  const walk = (a: unknown, b: unknown, path: string, depth: number) => {
    if (changes.length >= MAX_CHANGES) return;
    if (a === undefined && b !== undefined) changes.push({ path, kind: "added", after: b });
    else if (a !== undefined && b === undefined) changes.push({ path, kind: "removed", before: a });
    else if (isPlain(a) && isPlain(b) && depth < 3) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(a[key], b[key], path ? `${path}.${key}` : key, depth + 1);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, kind: "changed", before: a, after: b });
  };
  walk(before, after, "", 0);
  return changes;
}
