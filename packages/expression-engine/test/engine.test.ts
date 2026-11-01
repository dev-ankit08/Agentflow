import { describe, expect, it } from "vitest";
import { checkFormula, checkTemplate, evaluate, references, parse, renderTemplate } from "../src";

const scope = {
  triage: { output: { intent: "refund", order_id: "1042", confidence: 0.82 } },
  order: {
    amount: 640,
    items: [
      { sku: "A", price: 10 },
      { sku: "B", price: 25 },
    ],
    placed: "2026-10-01T00:00:00Z",
  },
  user: { plan: "vip", email: "jane@example.com" },
  tags: ["new", "priority"],
  empty: "",
};

describe("evaluate", () => {
  it.each([
    ['triage.output.intent == "refund" AND order.amount > 500', true],
    ['triage.output.intent = "refund"', true],
    ["order.amount >= 640 && NOT ISBLANK(triage.output.order_id)", true],
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["-order.amount + 40", -600],
    ['"Order " & triage.output.order_id', "Order 1042"],
    ['"a" + 1', "a1"],
    ["10 % 4", 2],
    ["order.items[1].sku", "B"],
    ["order.items[-1].price", 25],
    ['user["email"]', "jane@example.com"],
    ["missing.deep.path", null],
    ["missing == null", true],
    ['IF(order.amount > 1000, "big", "small")', "small"],
    ['COALESCE(empty, missing, "fallback")', "fallback"],
    ["LEN(tags)", 2],
    ['CONTAINS(tags, "priority")', true],
    ['CONTAINS("Hello World", "world")', true],
    ['UPPER(TRIM("  hi "))', "HI"],
    ['JOIN(SPLIT("a,b,c", ","), "-")', "a-b-c"],
    ['SUM(MAP(order.items, "item.price"))', 35],
    ['LEN(FILTER(order.items, "item.price > 15"))', 1],
    ['JSONPATH(order, "$.items[*].sku")', ["A", "B"]],
    ['JSONPATH(order, "$.items[0].price")', 10],
    ["ROUND(triage.output.confidence * 100, 0)", 82],
    ['DATEDIFF("2026-10-11T00:00:00Z", order.placed, "day")', 10],
    ['FORMAT_DATE(DATEADD(order.placed, 1, "month"), "YYYY-MM-DD")', "2026-11-01"],
    ['REGEX_MATCH(user.email, "@example\\\\.com$")', true],
    ["[1, 2, 3][0]", 1],
    ['{"a": 1, b: order.amount}.b', 640],
    ['"1042" == 1042', true],
    ["true AND false OR true", true],
  ])("%s", (src, expected) => {
    expect(evaluate(src, scope)).toEqual(expected);
  });

  it("short-circuits IF, AND and OR", () => {
    expect(evaluate("IF(true, 1, 1 / 0)", {})).toBe(1);
    expect(evaluate("false AND 1 / 0", {})).toBe(false);
  });

  it("blocks prototype access", () => {
    expect(evaluate("user.constructor", scope)).toBeNull();
    expect(evaluate('user["__proto__"]', scope)).toBeNull();
  });

  it("reports errors with positions", () => {
    expect(() => evaluate("1 +", {})).toThrow(/end of formula/);
    expect(() => evaluate("NOPE(1)", {})).toThrow(/Unknown function/);
    expect(() => evaluate("1 / 0", {})).toThrow(/Division by zero/);
    expect(checkFormula('a == "x')).toMatchObject({ message: "Unterminated string", position: 5 });
  });

  it("lists referenced variables", () => {
    expect(references(parse('triage.output.intent == "x" AND LEN(order.items) > user.limits[0]'))).toEqual([
      "triage.output.intent",
      "order.items",
      "user.limits",
    ]);
  });
});

describe("templates", () => {
  it("renders values and objects", () => {
    expect(renderTemplate("Hi {{ user.email }}, order {{triage.output.order_id}}", scope)).toBe(
      "Hi jane@example.com, order 1042",
    );
    expect(renderTemplate("{{tags}}", scope)).toBe('["new","priority"]');
    expect(renderTemplate("{{missing}}!", scope)).toBe("!");
  });

  it("renders conditional context blocks, including else and nesting", () => {
    const t = 'A{{#if user.plan == "vip"}} VIP{{#if order.amount > 500}} big{{/if}}{{else}} std{{/if}}.';
    expect(renderTemplate(t, scope)).toBe("A VIP big.");
    expect(renderTemplate(t, { ...scope, user: { plan: "free" } })).toBe("A std.");
  });

  it("checks block structure and formulas", () => {
    expect(checkTemplate("{{#if a}}x")).toEqual([{ message: "{{#if}} is missing its {{/if}}", position: 0 }]);
    expect(checkTemplate("x{{/if}}")[0]?.message).toMatch(/without a matching/);
    expect(checkTemplate("{{ a + }}")[0]?.message).toMatch(/end of formula/);
    expect(checkTemplate('ok {{a}} {{#if b == "c"}}y{{/if}}')).toEqual([]);
  });
});
