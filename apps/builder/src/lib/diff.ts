import type { FlowInput } from "@agentflow/flow-schema";

export type DiffRow =
  | { kind: "same"; left: string; right: string }
  | { kind: "removed"; left: string }
  | { kind: "added"; right: string }
  | { kind: "changed"; left: string; right: string };

/**
 * Line diff (longest common subsequence) for side-by-side display. A removed line followed by an added line is
 * shown as one changed row.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split("\n").slice(0, 400);
  const b = after.split("\n").slice(0, 400);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const raw: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      raw.push({ kind: "same", left: a[i]!, right: b[j]! });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      raw.push({ kind: "added", right: b[j++]! });
    } else {
      raw.push({ kind: "removed", left: a[i++]! });
    }
  }
  // Pair runs of removed lines with the added lines that follow them.
  const rows: DiffRow[] = [];
  for (let k = 0; k < raw.length; k++) {
    const removed: string[] = [];
    while (raw[k]?.kind === "removed") removed.push((raw[k++] as { left: string }).left);
    const added: string[] = [];
    while (raw[k]?.kind === "added") added.push((raw[k++] as { right: string }).right);
    for (let n = 0; n < Math.max(removed.length, added.length); n++) {
      const l = removed[n];
      const r = added[n];
      rows.push(
        l !== undefined && r !== undefined
          ? { kind: "changed", left: l, right: r }
          : l !== undefined
            ? { kind: "removed", left: l }
            : { kind: "added", right: r! },
      );
    }
    if (k < raw.length) rows.push(raw[k]!);
  }
  return rows;
}

type NodeInput = FlowInput["nodes"][number];

/** Prompt-like text fields of a node, labelled for display. */
export function promptFields(node: NodeInput): [string, string][] {
  const c = node.config as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (node.type) {
    case "agent":
      return [
        ["System prompt", str(c.systemPrompt)],
        ["User message", str(c.userPrompt)],
      ];
    case "supervisor":
      return [
        ["Instructions", str(c.instructions)],
        ["Task", str(c.task)],
        ...((c.workers as { id: string; systemPrompt?: string }[] | undefined) ?? []).map((w): [string, string] => [
          `Specialist “${w.id}” prompt`,
          str(w.systemPrompt),
        ]),
      ];
    case "parallel":
      return ((c.tasks as { id: string; systemPrompt?: string; userPrompt?: string }[] | undefined) ?? []).flatMap(
        (t): [string, string][] => [
          [`Task “${t.id}” system prompt`, str(t.systemPrompt)],
          [`Task “${t.id}” user message`, str(t.userPrompt)],
        ],
      );
    case "end":
    case "handoff":
      return [["Reply", str(c.message)]];
    case "approval":
      return [
        ["Request to approver", str(c.message)],
        ["Reply while waiting", str(c.pendingMessage)],
      ];
    default:
      return [];
  }
}

export type PromptChange = { node: string; field: string; rows: DiffRow[] };

/** Prompt edits between two versions of a flow, for nodes present in both or added. */
export function promptChanges(before: FlowInput | null, after: FlowInput): PromptChange[] {
  const old = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const out: PromptChange[] = [];
  for (const n of after.nodes) {
    const prev = old.get(n.id);
    const prevFields = new Map(prev ? promptFields(prev) : []);
    for (const [field, text] of promptFields(n)) {
      const was = prevFields.get(field) ?? "";
      if (was === text) continue;
      out.push({ node: `${n.label} (${n.id})`, field, rows: lineDiff(was, text) });
    }
  }
  return out;
}
