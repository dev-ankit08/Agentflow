import { evaluate, isTruthy, toText, type Scope } from "./evaluate";
import { ExpressionError, parse } from "./parser";

/**
 * Text templates for prompts and messages:
 *   {{ expr }}                         → value of the formula
 *   {{#if expr}} … {{else}} … {{/if}}  → conditional context blocks (may nest)
 */
type Part =
  | { kind: "text"; text: string }
  | { kind: "expr"; src: string; pos: number }
  | { kind: "if"; cond: string; pos: number; then: Part[]; else: Part[] };

const TAG = /\{\{\s*([\s\S]*?)\s*\}\}/g;

function compile(template: string): Part[] {
  const root: Part[] = [];
  const stack: { part: Extract<Part, { kind: "if" }>; inElse: boolean }[] = [];
  const target = () => {
    const top = stack[stack.length - 1];
    return top ? (top.inElse ? top.part.else : top.part.then) : root;
  };
  let last = 0;
  for (const m of template.matchAll(TAG)) {
    const pos = m.index!;
    if (pos > last) target().push({ kind: "text", text: template.slice(last, pos) });
    last = pos + m[0].length;
    const body = m[1]!;
    if (body.startsWith("#if ") || body.startsWith("#if(")) {
      const part = { kind: "if" as const, cond: body.slice(3).trim(), pos, then: [], else: [] };
      target().push(part);
      stack.push({ part, inElse: false });
    } else if (body === "else") {
      const top = stack[stack.length - 1];
      if (!top || top.inElse) throw new ExpressionError("{{else}} without a matching {{#if}}", pos);
      top.inElse = true;
    } else if (body === "/if") {
      if (!stack.pop()) throw new ExpressionError("{{/if}} without a matching {{#if}}", pos);
    } else {
      target().push({ kind: "expr", src: body, pos });
    }
  }
  if (last < template.length) target().push({ kind: "text", text: template.slice(last) });
  if (stack.length) throw new ExpressionError("{{#if}} is missing its {{/if}}", stack[stack.length - 1]!.part.pos);
  return root;
}

function render(parts: Part[], scope: Scope): string {
  let out = "";
  for (const p of parts) {
    if (p.kind === "text") out += p.text;
    else if (p.kind === "expr") out += toText(evaluate(p.src, scope));
    else out += render(isTruthy(evaluate(p.cond, scope)) ? p.then : p.else, scope);
  }
  return out;
}

export function renderTemplate(template: string, scope: Scope): string {
  return render(compile(template), scope);
}

export type TemplateIssue = { message: string; position: number };

/** Checks block structure and every formula inside a template, without evaluating it. */
export function checkTemplate(template: string): TemplateIssue[] {
  let parts: Part[];
  try {
    parts = compile(template);
  } catch (e) {
    return [{ message: (e as Error).message, position: (e as ExpressionError).position ?? 0 }];
  }
  const issues: TemplateIssue[] = [];
  const walk = (ps: Part[]) => {
    for (const p of ps) {
      if (p.kind === "text") continue;
      const src = p.kind === "expr" ? p.src : p.cond;
      try {
        parse(src);
      } catch (e) {
        issues.push({ message: `${(e as Error).message} in "${src}"`, position: p.pos });
      }
      if (p.kind === "if") {
        walk(p.then);
        walk(p.else);
      }
    }
  };
  walk(parts);
  return issues;
}

/** Checks a single formula. */
export function checkFormula(src: string): TemplateIssue | null {
  try {
    parse(src);
    return null;
  } catch (e) {
    return { message: (e as Error).message, position: (e as ExpressionError).position ?? 0 };
  }
}
