import { LineCounter, isMap, isSeq, parseDocument, type Node as YamlNode } from "yaml";
import { evaluate, isTruthy, toText, type Scope } from "./evaluate";
import { checkFormula, checkTemplate, renderTemplate } from "./template";

/**
 * Context rules: a YAML list that decides, from variables and without any AI, which context an AI step receives.
 *
 *   - when: user.plan == "vip"          # formula
 *     include: VIP customer.             # template ({{var}}, {{#if}})
 *     else: Standard customer.
 *   - switch: order.status
 *     cases: { shipped: "…", processing: "…" }
 *     default: "…"
 *   - first:                             # else-if chain: the first rule that applies
 *       - when: order.total > 1000
 *         include: "…"
 *       - include: "…"
 *   - title: Policies                    # rendered as a heading; a rule with only include always applies
 *     include: "{{knowledge.context}}"
 */
export type ContextRule =
  | { kind: "when"; id?: string; title?: string; when: string; include: string; else?: string; line: number }
  | {
      kind: "switch";
      id?: string;
      title?: string;
      switch: string;
      cases: Record<string, string>;
      default?: string;
      line: number;
    }
  | { kind: "first"; id?: string; title?: string; rules: ContextRule[]; line: number }
  | { kind: "always"; id?: string; title?: string; include: string; line: number };

export type ContextRuleIssue = { message: string; line: number };
export type ContextRuleTrace = {
  rule: string;
  matched: boolean;
  branch: "include" | "else" | "default" | `case:${string}` | null;
};

export const MAX_CONTEXT_RULES = 50;
export const MAX_CONTEXT_BLOCK = 20_000;

const KEYS = new Set(["id", "title", "when", "include", "else", "switch", "cases", "default", "first"]);

const scalarText = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/** Parses the YAML and checks the shape of every rule. Issues carry 1-based line numbers. */
export function parseContextRules(source: string): { rules: ContextRule[]; issues: ContextRuleIssue[] } {
  if (!source.trim()) return { rules: [], issues: [] };
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });
  const lineOf = (node: YamlNode | null | undefined) => (node?.range ? lines.linePos(node.range[0]).line : 1);
  const issues: ContextRuleIssue[] = doc.errors.map((e) => ({
    message: e.message.split("\n")[0]!,
    line: e.linePos?.[0]?.line ?? 1,
  }));
  if (issues.length) return { rules: [], issues };
  if (doc.contents === null) return { rules: [], issues: [] };
  if (!isSeq(doc.contents)) {
    return {
      rules: [],
      issues: [{ message: 'Context rules must be a list: start each rule with "- "', line: lineOf(doc.contents) }],
    };
  }

  let count = 0;
  const parseList = (seq: YamlNode, path: string): ContextRule[] => {
    if (!isSeq(seq)) return [];
    const out: ContextRule[] = [];
    seq.items.forEach((item, i) => {
      const where = `${path}${i + 1}`;
      const line = lineOf(item as YamlNode);
      const fail = (message: string) => issues.push({ message: `Rule ${where}: ${message}`, line });
      if (++count > MAX_CONTEXT_RULES) {
        if (count === MAX_CONTEXT_RULES + 1) fail(`at most ${MAX_CONTEXT_RULES} rules are allowed`);
        return;
      }
      if (!isMap(item)) return fail('each rule is a mapping, e.g. "when: …" and "include: …"');
      const value = (item as unknown as { toJSON(): Record<string, unknown> }).toJSON();
      for (const key of Object.keys(value)) if (!KEYS.has(key)) fail(`unknown key "${key}"`);
      const id = value.id === undefined ? undefined : (scalarText(value.id) ?? undefined);
      const title = value.title === undefined ? undefined : (scalarText(value.title) ?? undefined);
      const text = (key: string): string | undefined => {
        if (value[key] === undefined || value[key] === null) return undefined;
        const t = scalarText(value[key]);
        if (t === null) {
          fail(`"${key}" must be text`);
          return undefined;
        }
        if (t.length > MAX_CONTEXT_BLOCK) fail(`"${key}" is longer than ${MAX_CONTEXT_BLOCK} characters`);
        return t;
      };
      const base = { ...(id !== undefined && { id }), ...(title !== undefined && { title }), line };

      if (value.first !== undefined) {
        const firstNode = (item as unknown as { get(k: string, keep: true): YamlNode }).get("first", true);
        if (!isSeq(firstNode)) return fail('"first" must be a list of rules');
        for (const k of ["when", "switch", "include", "else", "cases", "default"])
          if (value[k] !== undefined) fail(`"first" can't be combined with "${k}" in the same rule`);
        out.push({ kind: "first", ...base, rules: parseList(firstNode, `${where}.`) });
        return;
      }
      if (value.switch !== undefined) {
        const sw = text("switch");
        const casesNode = value.cases;
        if (!casesNode || typeof casesNode !== "object" || Array.isArray(casesNode)) {
          return fail('"cases" must be a mapping of value: text');
        }
        const cases: Record<string, string> = {};
        for (const [k, v] of Object.entries(casesNode as Record<string, unknown>)) {
          const t = scalarText(v);
          if (t === null) fail(`case "${k}" must be text`);
          else cases[k] = t;
        }
        if (value.when !== undefined || value.include !== undefined || value.else !== undefined)
          fail('use "cases"/"default" with "switch", not "when"/"include"/"else"');
        if (sw !== undefined)
          out.push({
            kind: "switch",
            ...base,
            switch: sw,
            cases,
            ...(text("default") !== undefined && { default: text("default")! }),
          });
        return;
      }
      const include = text("include");
      if (value.when !== undefined) {
        const when = text("when");
        if (include === undefined) return fail('"when" needs an "include"');
        if (when !== undefined)
          out.push({
            kind: "when",
            ...base,
            when,
            include,
            ...(text("else") !== undefined && { else: text("else")! }),
          });
        return;
      }
      if (value.else !== undefined) return fail('"else" needs a "when"');
      if (value.cases !== undefined || value.default !== undefined) return fail('"cases"/"default" need a "switch"');
      if (include === undefined) return fail('add "include" (text), optionally with "when" or use "switch"/"first"');
      out.push({ kind: "always", ...base, include });
    });
    return out;
  };

  const rules = parseList(doc.contents, "");
  return { rules, issues };
}

/** Everything that would stop the rules from running: YAML, shape, formulas and templates. */
export function checkContextRules(source: string): ContextRuleIssue[] {
  const { rules, issues } = parseContextRules(source);
  const formula = (src: string, line: number, label: string) => {
    if (src.includes("{{")) return issues.push({ message: `${label}: formulas are written without {{ }}`, line });
    const issue = checkFormula(src);
    if (issue) issues.push({ message: `${label}: ${issue.message}`, line });
  };
  const template = (src: string | undefined, line: number, label: string) => {
    if (src === undefined) return;
    for (const issue of checkTemplate(src)) issues.push({ message: `${label}: ${issue.message}`, line });
  };
  const walk = (list: ContextRule[]) => {
    for (const r of list) {
      if (r.kind === "when") {
        formula(r.when, r.line, '"when"');
        template(r.include, r.line, '"include"');
        template(r.else, r.line, '"else"');
      } else if (r.kind === "switch") {
        formula(r.switch, r.line, '"switch"');
        for (const [k, v] of Object.entries(r.cases)) template(v, r.line, `case "${k}"`);
        template(r.default, r.line, '"default"');
      } else if (r.kind === "first") walk(r.rules);
      else template(r.include, r.line, '"include"');
    }
  };
  walk(rules);
  return issues;
}

/**
 * Evaluates the rules in order and returns the context text (matched blocks joined, empty ones skipped) and a
 * trace of which rules matched. Invalid rules are skipped; validation reports them before publishing.
 */
export function renderContextRules(source: string, scope: Scope): { text: string; trace: ContextRuleTrace[] } {
  const { rules } = parseContextRules(source);
  const trace: ContextRuleTrace[] = [];
  const blocks: string[] = [];
  const block = (title: string | undefined, body: string) => {
    const t = body.slice(0, MAX_CONTEXT_BLOCK).trim();
    if (t) blocks.push(title ? `### ${title}\n${t}` : t);
  };
  const safeEval = (src: string) => {
    try {
      return evaluate(src, scope);
    } catch {
      return null;
    }
  };
  const safeRender = (src: string) => {
    try {
      return renderTemplate(src, scope);
    } catch {
      return "";
    }
  };

  /** Runs one rule; returns whether it applied (used by "first"). */
  const run = (r: ContextRule, name: string): boolean => {
    const label = r.id ?? name;
    if (r.kind === "always") {
      block(r.title, safeRender(r.include));
      trace.push({ rule: label, matched: true, branch: "include" });
      return true;
    }
    if (r.kind === "when") {
      const ok = isTruthy(safeEval(r.when));
      if (ok) block(r.title, safeRender(r.include));
      else if (r.else !== undefined) block(r.title, safeRender(r.else));
      trace.push({ rule: label, matched: ok, branch: ok ? "include" : r.else !== undefined ? "else" : null });
      return ok || r.else !== undefined;
    }
    if (r.kind === "switch") {
      const key = toText(safeEval(r.switch));
      if (Object.hasOwn(r.cases, key)) {
        block(r.title, safeRender(r.cases[key]!));
        trace.push({ rule: label, matched: true, branch: `case:${key}` });
        return true;
      }
      if (r.default !== undefined) block(r.title, safeRender(r.default));
      trace.push({ rule: label, matched: false, branch: r.default !== undefined ? "default" : null });
      return r.default !== undefined;
    }
    // first: the first child that applies wins; the rest are recorded as not matched.
    let done = false;
    r.rules.forEach((child, i) => {
      const childName = `${name}.${i + 1}`;
      if (done) trace.push({ rule: child.id ?? childName, matched: false, branch: null });
      else done = run(child, childName);
    });
    trace.push({ rule: label, matched: done, branch: null });
    return done;
  };

  rules.forEach((r, i) => run(r, String(i + 1)));
  return { text: blocks.join("\n\n"), trace };
}
