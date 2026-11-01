import { ExpressionError, parse, type Node } from "./parser";

export type Scope = Record<string, unknown>;

const MAX_REGEX_INPUT = 10_000;
const MAX_REGEX_PATTERN = 200;

export function isTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v) && !(typeof v === "number" && Number.isNaN(v));
}

const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new ExpressionError(`"${toText(v)}" is not a number`, 0);
  return n;
}

function toDate(v: unknown): Date {
  const d = v instanceof Date ? v : new Date(toText(v));
  if (Number.isNaN(d.getTime())) throw new ExpressionError(`"${toText(v)}" is not a date`, 0);
  return d;
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

function equals(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === "number" || typeof b === "number") {
    if (a === null || a === undefined || b === null || b === undefined || a === "" || b === "") return false;
    return Number(a) === Number(b);
  }
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" || typeof b === "number") return toNumber(a) - toNumber(b);
  const sa = toText(a);
  const sb = toText(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function get(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return null;
  if (typeof key === "number" && Array.isArray(obj)) return obj[key < 0 ? obj.length + key : key] ?? null;
  const k = toText(key);
  if (k === "__proto__" || k === "constructor" || k === "prototype") return null;
  if (typeof obj === "string" && k === "length") return obj.length;
  if (typeof obj !== "object") return null;
  return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string, unknown>)[k] : null;
}

/** Minimal JSONPath: `$.a.b[0]`, `$.items[*].price`, `$['key']`. */
function jsonPath(root: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").match(/[^.[\]]+|\[\*\]|\[\d+\]|\['[^']*'\]/g) ?? [];
  let current: unknown[] = [root];
  let multi = false;
  for (const raw of parts) {
    if (raw === "[*]" || raw === "*") {
      multi = true;
      current = current.flatMap((v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []));
      continue;
    }
    const key = raw.startsWith("[") ? raw.slice(1, -1).replace(/^'|'$/g, "") : raw;
    const idx = /^\d+$/.test(key) ? Number(key) : key;
    current = current.map((v) => get(v, idx));
  }
  return multi ? current : (current[0] ?? null);
}

type Fn = (args: Node[], scope: Scope, ev: (n: Node, s?: Scope) => unknown) => unknown;
const eager =
  (f: (...args: unknown[]) => unknown): Fn =>
  (args, scope, ev) =>
    f(...args.map((a) => ev(a, scope)));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);

function withItem(source: unknown, itemExpr: unknown, scope: Scope) {
  const ast = parse(toText(itemExpr));
  return list(source).map((item, index) => ({ item, value: evaluateAst(ast, { ...scope, item, index }) }));
}

const functions: Record<string, Fn> = {
  IF: (args, scope, ev) => (isTruthy(ev(args[0]!, scope)) ? ev(args[1]!, scope) : args[2] ? ev(args[2], scope) : null),
  AND: (args, scope, ev) => args.every((a) => isTruthy(ev(a, scope))),
  OR: (args, scope, ev) => args.some((a) => isTruthy(ev(a, scope))),
  NOT: eager((v) => !isTruthy(v)),
  ISBLANK: eager(isBlank),
  COALESCE: (args, scope, ev) => {
    for (const a of args) {
      const v = ev(a, scope);
      if (!isBlank(v)) return v;
    }
    return null;
  },
  LEN: eager((v) => (Array.isArray(v) ? v.length : toText(v).length)),
  LOWER: eager((v) => toText(v).toLowerCase()),
  UPPER: eager((v) => toText(v).toUpperCase()),
  TRIM: eager((v) => toText(v).trim()),
  CONTAINS: eager((v, sub) =>
    Array.isArray(v) ? v.some((x) => equals(x, sub)) : toText(v).toLowerCase().includes(toText(sub).toLowerCase()),
  ),
  STARTSWITH: eager((v, p) => toText(v).startsWith(toText(p))),
  ENDSWITH: eager((v, p) => toText(v).endsWith(toText(p))),
  REPLACE: eager((v, find, rep) => toText(v).split(toText(find)).join(toText(rep))),
  SPLIT: eager((v, sep) => toText(v).split(toText(sep))),
  JOIN: eager((v, sep) =>
    list(v)
      .map(toText)
      .join(sep === undefined ? ", " : toText(sep)),
  ),
  REGEX_MATCH: eager((v, pattern) => {
    const p = toText(pattern);
    if (p.length > MAX_REGEX_PATTERN) throw new ExpressionError("Regex pattern too long", 0);
    return new RegExp(p, "i").test(toText(v).slice(0, MAX_REGEX_INPUT));
  }),
  NUMBER: eager((v) => toNumber(v)),
  TEXT: eager((v) => toText(v)),
  ROUND: eager((v, d) => {
    const f = 10 ** toNumber(d ?? 0);
    return Math.round(toNumber(v) * f) / f;
  }),
  SUM: eager((...vs) => vs.flatMap(list).reduce<number>((s, x) => s + toNumber(x), 0)),
  MIN: eager((...vs) => Math.min(...vs.flatMap(list).map(toNumber))),
  MAX: eager((...vs) => Math.max(...vs.flatMap(list).map(toNumber))),
  NOW: () => new Date().toISOString(),
  TODAY: () => new Date().toISOString().slice(0, 10),
  DATEADD: eager((d, n, unit) => {
    const date = toDate(d);
    const u = toText(unit ?? "day").replace(/s$/, "");
    if (u === "month" || u === "year") {
      const copy = new Date(date);
      if (u === "month") copy.setUTCMonth(copy.getUTCMonth() + toNumber(n));
      else copy.setUTCFullYear(copy.getUTCFullYear() + toNumber(n));
      return copy.toISOString();
    }
    const ms = UNIT_MS[u];
    if (!ms) throw new ExpressionError(`Unknown date unit "${u}"`, 0);
    return new Date(date.getTime() + toNumber(n) * ms).toISOString();
  }),
  DATEDIFF: eager((a, b, unit) => {
    const u = toText(unit ?? "day").replace(/s$/, "");
    const ms = UNIT_MS[u];
    if (!ms) throw new ExpressionError(`Unknown date unit "${u}"`, 0);
    return Math.floor((toDate(a).getTime() - toDate(b).getTime()) / ms);
  }),
  FORMAT_DATE: eager((d, fmt) => {
    const date = toDate(d);
    const pad = (n: number) => String(n).padStart(2, "0");
    return toText(fmt ?? "YYYY-MM-DD")
      .replace("YYYY", String(date.getUTCFullYear()))
      .replace("MM", pad(date.getUTCMonth() + 1))
      .replace("DD", pad(date.getUTCDate()))
      .replace("HH", pad(date.getUTCHours()))
      .replace("mm", pad(date.getUTCMinutes()));
  }),
  JSONPATH: eager((obj, path) => jsonPath(obj, toText(path))),
  FILTER: (args, scope, ev) =>
    withItem(ev(args[0]!, scope), ev(args[1]!, scope), scope)
      .filter((r) => isTruthy(r.value))
      .map((r) => r.item),
  MAP: (args, scope, ev) => withItem(ev(args[0]!, scope), ev(args[1]!, scope), scope).map((r) => r.value),
  JSON: eager((v) => toText(v)),
  PARSE_JSON: eager((v) => {
    try {
      return JSON.parse(toText(v));
    } catch {
      return null;
    }
  }),
};

export const functionNames = Object.keys(functions).sort();

export function evaluateAst(node: Node, scope: Scope): unknown {
  const ev = (n: Node, s: Scope = scope) => evaluateAst(n, s);
  switch (node.kind) {
    case "literal":
      return node.value;
    case "ident":
      return Object.prototype.hasOwnProperty.call(scope, node.name) ? scope[node.name] : null;
    case "member":
      return get(ev(node.object), ev(node.property));
    case "array":
      return node.items.map((i) => ev(i));
    case "object":
      return Object.fromEntries(node.entries.map(([k, v]) => [k, ev(v)]));
    case "unary":
      return node.op === "NOT" ? !isTruthy(ev(node.operand)) : -toNumber(ev(node.operand));
    case "call": {
      const fn = functions[node.name];
      if (!fn) throw new ExpressionError(`Unknown function ${node.name}()`, 0);
      return fn(node.args, scope, ev);
    }
    case "binary": {
      if (node.op === "AND") return isTruthy(ev(node.left)) && isTruthy(ev(node.right));
      if (node.op === "OR") return isTruthy(ev(node.left)) || isTruthy(ev(node.right));
      const l = ev(node.left);
      const r = ev(node.right);
      switch (node.op) {
        case "==":
          return equals(l, r);
        case "!=":
          return !equals(l, r);
        case ">":
          return compare(l, r) > 0;
        case ">=":
          return compare(l, r) >= 0;
        case "<":
          return compare(l, r) < 0;
        case "<=":
          return compare(l, r) <= 0;
        case "&":
          return toText(l) + toText(r);
        case "+":
          return typeof l === "string" || typeof r === "string" ? toText(l) + toText(r) : toNumber(l) + toNumber(r);
        case "-":
          return toNumber(l) - toNumber(r);
        case "*":
          return toNumber(l) * toNumber(r);
        case "/": {
          const d = toNumber(r);
          if (d === 0) throw new ExpressionError("Division by zero", 0);
          return toNumber(l) / d;
        }
        case "%":
          return toNumber(l) % toNumber(r);
      }
      throw new ExpressionError(`Unknown operator ${node.op}`, 0);
    }
  }
}

const cache = new Map<string, Node>();

/** Parses (with a small cache) and evaluates a formula against a scope of variables. */
export function evaluate(src: string, scope: Scope): unknown {
  let ast = cache.get(src);
  if (!ast) {
    ast = parse(src);
    if (cache.size > 1000) cache.clear();
    cache.set(src, ast);
  }
  return evaluateAst(ast, scope);
}
