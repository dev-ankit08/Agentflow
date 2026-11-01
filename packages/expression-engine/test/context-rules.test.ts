import { describe, expect, it } from "vitest";
import { checkContextRules, parseContextRules, renderContextRules } from "../src";

const RULES = `
# Evaluated top to bottom; no AI involved.
- id: vip
  when: user.plan == "vip"
  include: The customer is VIP. Offer free express shipping.
- id: refund
  when: intent == "refund" AND order.total > 500
  include: Refunds over $500 need manager approval.
  else: Refunds under $500 can be confirmed now.
- id: status
  switch: order.status
  cases:
    shipped: "Give the ETA: {{order.eta}}"
    processing: Say it ships within 2 days.
  default: Ask for the order number.
- id: size
  first:
    - when: order.total > 1000
      include: High-value order.
    - when: order.total > 100
      include: Standard order.
    - include: Small order.
- title: Store policies
  include: "{{policies}}"
`;

describe("context rules", () => {
  it("sends only the blocks whose conditions match", () => {
    const { text, trace } = renderContextRules(RULES, {
      user: { plan: "vip" },
      intent: "refund",
      order: { total: 640, status: "shipped", eta: "Thursday" },
      policies: "Returns within 30 days.",
    });
    expect(text).toBe(
      [
        "The customer is VIP. Offer free express shipping.",
        "Refunds over $500 need manager approval.",
        "Give the ETA: Thursday",
        "Standard order.",
        "### Store policies\nReturns within 30 days.",
      ].join("\n\n"),
    );
    expect(trace).toEqual([
      { rule: "vip", matched: true, branch: "include" },
      { rule: "refund", matched: true, branch: "include" },
      { rule: "status", matched: true, branch: "case:shipped" },
      { rule: "4.1", matched: false, branch: null },
      { rule: "4.2", matched: true, branch: "include" },
      { rule: "4.3", matched: false, branch: null },
      { rule: "size", matched: true, branch: null },
      { rule: "5", matched: true, branch: "include" },
    ]);
  });

  it("takes else, default and fallback branches, and skips empty blocks", () => {
    const { text, trace } = renderContextRules(RULES, {
      user: { plan: "basic" },
      intent: "other",
      order: { total: 50, status: "lost" },
      policies: "",
    });
    expect(text).toBe(
      ["Refunds under $500 can be confirmed now.", "Ask for the order number.", "Small order."].join("\n\n"),
    );
    expect(trace.find((t) => t.rule === "vip")).toEqual({ rule: "vip", matched: false, branch: null });
    expect(trace.find((t) => t.rule === "refund")).toMatchObject({ matched: false, branch: "else" });
    expect(trace.find((t) => t.rule === "status")).toMatchObject({ matched: false, branch: "default" });
  });

  it("allows {{#if}} inside an include", () => {
    const src = `- include: "Hello{{#if user.name}} {{user.name}}{{/if}}."`;
    expect(renderContextRules(src, { user: { name: "Ana" } }).text).toBe("Hello Ana.");
    expect(renderContextRules(src, { user: {} }).text).toBe("Hello.");
  });

  it("reports YAML errors with line numbers", () => {
    const issues = checkContextRules(`- when: a == 1\n  include: [unclosed\n`);
    expect(issues[0]!.line).toBeGreaterThanOrEqual(2);
  });

  it("explains wrong shapes", () => {
    expect(checkContextRules(`when: a == 1`)[0]!.message).toMatch(/must be a list/);
    expect(checkContextRules(`- when: a == 1`)[0]!.message).toBe('Rule 1: "when" needs an "include"');
    expect(checkContextRules(`- include: x\n- switch: s\n  cases: [a, b]`)[0]).toEqual({
      message: 'Rule 2: "cases" must be a mapping of value: text',
      line: 2,
    });
    expect(checkContextRules(`- include: x\n  colour: red`)[0]!.message).toBe('Rule 1: unknown key "colour"');
    expect(checkContextRules(`- else: x`)[0]!.message).toBe('Rule 1: "else" needs a "when"');
  });

  it("checks formulas and templates inside rules", () => {
    expect(checkContextRules(`- when: "{{user.plan}} == 'vip'"\n  include: x`)[0]!.message).toBe(
      '"when": formulas are written without {{ }}',
    );
    expect(checkContextRules(`- when: user.plan ==\n  include: x`)[0]!.message).toMatch(/^"when": /);
    expect(checkContextRules(`- include: "{{#if a}}open"`)[0]!.message).toMatch(/^"include": .*\{\{\/if\}\}/);
    expect(checkContextRules(RULES)).toEqual([]);
  });

  it("treats empty rules as no rules", () => {
    expect(parseContextRules("  \n# just a comment\n")).toEqual({ rules: [], issues: [] });
    expect(renderContextRules("", {})).toEqual({ text: "", trace: [] });
  });
});
