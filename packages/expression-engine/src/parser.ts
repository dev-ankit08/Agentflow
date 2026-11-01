/**
 * Formula language (docs/02-feature-spec.md §4.3): a small, sandboxed expression grammar.
 * Source is tokenised and parsed (Pratt) into an AST; nothing is ever passed to eval.
 */

export type Node =
  | { kind: "literal"; value: unknown }
  | { kind: "ident"; name: string }
  | { kind: "member"; object: Node; property: Node; computed: boolean }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "unary"; op: "-" | "NOT"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "array"; items: Node[] }
  | { kind: "object"; entries: [string, Node][] };

export class ExpressionError extends Error {
  constructor(
    message: string,
    public position: number,
  ) {
    super(message);
  }
}

type Token =
  | { type: "num"; value: number; pos: number }
  | { type: "str"; value: string; pos: number }
  | { type: "ident"; value: string; pos: number }
  | { type: "op"; value: string; pos: number }
  | { type: "eof"; pos: number };

const KEYWORD_OPS = new Set(["AND", "OR", "NOT"]);
const MULTI_OPS = ["==", "!=", ">=", "<=", "&&", "||"];
const SINGLE_OPS = new Set(["+", "-", "*", "/", "%", ">", "<", "&", "(", ")", "[", "]", "{", "}", ",", ".", ":", "!"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const pos = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ type: "num", value: Number(m[0]), pos });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let out = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[i + 1]!;
          out += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else out += src[i++];
      }
      if (src[i] !== c) throw new ExpressionError("Unterminated string", pos);
      i++;
      tokens.push({ type: "str", value: out, pos });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      const word = m[0];
      tokens.push(
        KEYWORD_OPS.has(word.toUpperCase()) && word === word.toUpperCase()
          ? { type: "op", value: word.toUpperCase(), pos }
          : { type: "ident", value: word, pos },
      );
      i += word.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: "op", value: two === "&&" ? "AND" : two === "||" ? "OR" : two, pos });
      i += 2;
      continue;
    }
    if (c === "=") {
      tokens.push({ type: "op", value: "==", pos });
      i++;
      continue;
    }
    if (SINGLE_OPS.has(c)) {
      tokens.push({ type: "op", value: c === "!" ? "NOT" : c, pos });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${c}"`, pos);
  }
  tokens.push({ type: "eof", pos: src.length });
  return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  OR: 1,
  AND: 2,
  "==": 4,
  "!=": 4,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "&": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};
const POSTFIX = 9;

export function parse(src: string): Node {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p]!;
  const next = () => tokens[p++]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.type === "op" && t.value === v;
  };
  const expect = (v: string) => {
    const t = next();
    if (t.type !== "op" || t.value !== v) throw new ExpressionError(`Expected "${v}"`, t.pos);
  };

  function list(close: string): Node[] {
    const items: Node[] = [];
    if (!isOp(close)) {
      do items.push(expr(0));
      while (isOp(",") && next());
    }
    expect(close);
    return items;
  }

  function prefix(): Node {
    const t = next();
    switch (t.type) {
      case "num":
      case "str":
        return { kind: "literal", value: t.value };
      case "ident": {
        const lower = t.value.toLowerCase();
        if (lower === "true" || lower === "false") return { kind: "literal", value: lower === "true" };
        if (lower === "null") return { kind: "literal", value: null };
        if (isOp("(")) {
          next();
          return { kind: "call", name: t.value.toUpperCase(), args: list(")") };
        }
        return { kind: "ident", name: t.value };
      }
      case "op":
        if (t.value === "(") {
          const inner = expr(0);
          expect(")");
          return inner;
        }
        if (t.value === "-") return { kind: "unary", op: "-", operand: expr(8) };
        if (t.value === "NOT") return { kind: "unary", op: "NOT", operand: expr(3) };
        if (t.value === "[") return { kind: "array", items: list("]") };
        if (t.value === "{") {
          const entries: [string, Node][] = [];
          if (!isOp("}")) {
            do {
              const key = next();
              if (key.type !== "str" && key.type !== "ident") throw new ExpressionError("Expected object key", key.pos);
              expect(":");
              entries.push([String(key.value), expr(0)]);
            } while (isOp(",") && next());
          }
          expect("}");
          return { kind: "object", entries };
        }
        throw new ExpressionError(`Unexpected "${t.value}"`, t.pos);
      case "eof":
        throw new ExpressionError("Unexpected end of formula", t.pos);
    }
  }

  function expr(minPrec: number): Node {
    let left = prefix();
    for (;;) {
      const t = peek();
      if (t.type !== "op") break;
      if (t.value === "." && POSTFIX > minPrec) {
        next();
        const prop = next();
        if (prop.type !== "ident") throw new ExpressionError("Expected property name after '.'", prop.pos);
        left = { kind: "member", object: left, property: { kind: "literal", value: prop.value }, computed: false };
        continue;
      }
      if (t.value === "[" && POSTFIX > minPrec) {
        next();
        const property = expr(0);
        expect("]");
        left = { kind: "member", object: left, property, computed: true };
        continue;
      }
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec === undefined || prec <= minPrec) break;
      next();
      left = { kind: "binary", op: t.value, left, right: expr(prec) };
    }
    return left;
  }

  if (!src.trim()) throw new ExpressionError("Formula is empty", 0);
  const ast = expr(0);
  const end = peek();
  if (end.type !== "eof") throw new ExpressionError("Unexpected input after formula", end.pos);
  return ast;
}

/** Dotted variable paths a formula reads, e.g. `triage.output.intent`. Used for autocomplete and validation. */
export function references(ast: Node): string[] {
  const out = new Set<string>();
  const path = (n: Node): string | null => {
    if (n.kind === "ident") return n.name;
    if (n.kind === "member" && !n.computed) {
      const base = path(n.object);
      return base && `${base}.${String((n.property as { value: unknown }).value)}`;
    }
    return null;
  };
  const walk = (n: Node) => {
    const p = path(n);
    if (p) return void out.add(p);
    switch (n.kind) {
      case "member":
        walk(n.object);
        walk(n.property);
        break;
      case "call":
        n.args.forEach(walk);
        break;
      case "unary":
        walk(n.operand);
        break;
      case "binary":
        walk(n.left);
        walk(n.right);
        break;
      case "array":
        n.items.forEach(walk);
        break;
      case "object":
        n.entries.forEach(([, v]) => walk(v));
        break;
    }
  };
  walk(ast);
  return [...out];
}
