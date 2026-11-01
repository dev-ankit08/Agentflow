import type { FlowInput, ModelRef } from "@agentflow/flow-schema";

/**
 * Outcome templates (docs/02-feature-spec.md H1). Each builds a ready-to-test flow from the
 * choices made in the install wizard: which model to use and, when needed, which connector.
 */
export type TemplateParams = { id: string; name: string; model: ModelRef; connectorId?: string };

export type Template = {
  slug: string;
  name: string;
  category: "Support" | "Sales" | "Ops" | "HR/IT";
  description: string;
  outcome: string;
  minutes: number;
  /** Connector the template needs, with the tool names it uses. */
  connector?: { label: string; tools: string[]; hint: string };
  build(params: TemplateParams): FlowInput;
};

/** Canvas position on a simple grid: columns left to right, rows above/below the main path. */
const pos = (col: number, row = 0) => ({ x: col * 260, y: row * 140 });
const flow = (p: TemplateParams, rest: Omit<FlowInput, "schemaVersion" | "id" | "name">): FlowInput => ({
  schemaVersion: 1,
  id: p.id,
  name: p.name,
  ...rest,
});

const supportDeflection: Template = {
  slug: "support-deflection",
  name: "L1 Support Deflection",
  category: "Support",
  description: "Answers common questions from your help content and hands everything else to a human.",
  outcome: "Resolution rate",
  minutes: 10,
  build: (p) =>
    flow(p, {
      triggers: [{ type: "chat", config: {} }],
      variables: [],
      nodes: [
        { id: "start", type: "start", label: "Chat", position: pos(0), config: {} },
        {
          id: "triage",
          type: "agent",
          label: "Triage",
          position: pos(1),
          config: {
            model: p.model,
            systemPrompt:
              'Classify the customer\'s message for a support team. Use "faq" for questions answered by the help content below, "human" for account-specific problems, complaints or anything you cannot answer.\n\nHelp content:\n- Shipping takes 3-5 business days.\n- Returns are accepted within 30 days.\n- Support hours are 9am-6pm, Monday to Friday.',
            userPrompt: "{{trigger.message}}",
            outputSchema: {
              type: "object",
              properties: { route: { type: "string", enum: ["faq", "human"] }, topic: { type: "string" } },
              required: ["route"],
            },
          },
        },
        {
          id: "route",
          type: "decision",
          label: "Can we answer?",
          position: pos(2),
          config: { outcomes: [{ id: "faq", condition: 'triage.output.route == "faq"' }], defaultOutcome: "human" },
        },
        {
          id: "answer",
          type: "agent",
          label: "Answer",
          position: pos(3, -1),
          config: {
            model: p.model,
            systemPrompt:
              "You are a friendly support agent. Answer briefly using only this help content; if it does not cover the question, say a colleague will follow up.\n\n- Shipping takes 3-5 business days.\n- Returns are accepted within 30 days.\n- Support hours are 9am-6pm, Monday to Friday.",
            userPrompt: "{{trigger.message}}",
          },
        },
        {
          id: "resolved",
          type: "end",
          label: "Answered",
          position: pos(4, -1),
          config: { message: "{{answer.text}}", outcome: "resolved" },
        },
        {
          id: "human",
          type: "end",
          label: "To a human",
          position: pos(3, 1),
          config: {
            message: "Thanks — I've passed this to our support team and they'll get back to you shortly.",
            outcome: "escalated",
          },
        },
      ],
      edges: [
        { id: "e1", source: "start", target: "triage" },
        { id: "e2", source: "triage", target: "route" },
        { id: "e3", source: "route", sourceHandle: "faq", target: "answer" },
        { id: "e4", source: "route", sourceHandle: "human", target: "human" },
        { id: "e5", source: "answer", target: "resolved" },
      ],
    }),
};

const orderStatus: Template = {
  slug: "order-status",
  name: "Order Status & Returns",
  category: "Support",
  description: "Looks up live order data through your orders connector and answers status questions.",
  outcome: "Resolved without a human",
  minutes: 15,
  connector: {
    label: "Orders system",
    tools: ["get_order"],
    hint: "Any MCP server with a get_order(order_id) tool — try the bundled demo server (pnpm demo:mcp).",
  },
  build: (p) =>
    flow(p, {
      triggers: [{ type: "chat", config: {} }],
      variables: [],
      nodes: [
        { id: "start", type: "start", label: "Chat", position: pos(0), config: {} },
        {
          id: "triage",
          type: "agent",
          label: "Triage",
          position: pos(1),
          config: {
            model: p.model,
            systemPrompt: "Classify the customer's intent and extract an order id if present.",
            userPrompt: "{{trigger.message}}",
            outputSchema: {
              type: "object",
              properties: {
                intent: { type: "string", enum: ["order_status", "refund", "other"] },
                order_id: { type: "string" },
              },
              required: ["intent"],
            },
          },
        },
        {
          id: "route",
          type: "decision",
          label: "Route",
          position: pos(2),
          config: {
            outcomes: [
              {
                id: "status",
                condition: 'triage.output.intent == "order_status" AND NOT ISBLANK(triage.output.order_id)',
              },
              { id: "refund", condition: 'triage.output.intent == "refund"' },
            ],
            defaultOutcome: "other",
          },
        },
        {
          id: "lookup",
          type: "mcp_tool",
          label: "Get order",
          position: pos(3, -1),
          config: { connectorId: p.connectorId ?? "", tool: "get_order", args: { order_id: "triage.output.order_id" } },
        },
        {
          id: "answer",
          type: "agent",
          label: "Answer",
          position: pos(4, -1),
          config: {
            model: p.model,
            systemPrompt:
              'You are a friendly support agent. Answer using only the order data provided.{{#if user.plan == "vip"}} The customer is VIP: offer free express shipping on their next order.{{/if}}',
            userPrompt: "Question: {{trigger.message}}\nOrder data: {{lookup.result}}",
          },
        },
        {
          id: "done",
          type: "end",
          label: "Done",
          position: pos(5, -1),
          config: { message: "{{answer.text}}", outcome: "resolved" },
        },
        {
          id: "refund",
          type: "end",
          label: "Refund request",
          position: pos(3, 0.5),
          config: {
            message: "I've noted your refund request — our team will review it and email you within one business day.",
            outcome: "escalated",
          },
        },
        {
          id: "other",
          type: "end",
          label: "Ask for order id",
          position: pos(3, 1.5),
          config: { message: "I can help with orders. Could you share your order number?", outcome: "failed" },
        },
      ],
      edges: [
        { id: "e1", source: "start", target: "triage" },
        { id: "e2", source: "triage", target: "route" },
        { id: "e3", source: "route", sourceHandle: "status", target: "lookup" },
        { id: "e4", source: "route", sourceHandle: "refund", target: "refund" },
        { id: "e5", source: "route", sourceHandle: "other", target: "other" },
        { id: "e6", source: "lookup", target: "answer" },
        { id: "e7", source: "answer", target: "done" },
      ],
    }),
};

const leadQualification: Template = {
  slug: "lead-qualification",
  name: "Lead Qualification",
  category: "Sales",
  description: "Qualifies website visitors on budget, authority, need and timing, and routes hot leads to sales.",
  outcome: "Qualified leads",
  minutes: 10,
  build: (p) =>
    flow(p, {
      triggers: [{ type: "chat", config: {} }],
      variables: [{ name: "score", type: "number", default: 0 }],
      nodes: [
        { id: "start", type: "start", label: "Chat", position: pos(0), config: {} },
        {
          id: "qualify",
          type: "agent",
          label: "Qualify (BANT)",
          position: pos(1),
          config: {
            model: p.model,
            systemPrompt:
              "Assess this sales conversation. Score each of budget, authority, need and timing from 0 to 25 based on what the visitor has said so far.",
            userPrompt: "{{trigger.message}}",
            outputSchema: {
              type: "object",
              properties: {
                budget: { type: "number" },
                authority: { type: "number" },
                need: { type: "number" },
                timing: { type: "number" },
                company: { type: "string" },
              },
              required: ["budget", "authority", "need", "timing"],
            },
          },
        },
        {
          id: "total",
          type: "assignment",
          label: "Total score",
          position: pos(2),
          config: {
            assignments: [
              {
                variable: "score",
                value: "qualify.output.budget + qualify.output.authority + qualify.output.need + qualify.output.timing",
              },
            ],
          },
        },
        {
          id: "hot",
          type: "decision",
          label: "Hot lead?",
          position: pos(3),
          config: { outcomes: [{ id: "hot", condition: "score >= 60" }], defaultOutcome: "nurture" },
        },
        {
          id: "book",
          type: "end",
          label: "Offer a meeting",
          position: pos(4, -0.5),
          config: {
            message:
              "Great fit! Our team would love to show you a demo — pick a time that suits you and we'll confirm by email.",
            outcome: "converted",
          },
        },
        {
          id: "nurture",
          type: "agent",
          label: "Discovery question",
          position: pos(4, 0.7),
          config: {
            model: p.model,
            systemPrompt:
              "You are a helpful sales assistant. Ask one friendly question to learn more about the visitor's needs, team size or timeline.",
            userPrompt: "{{trigger.message}}",
          },
        },
        { id: "reply", type: "end", label: "Reply", position: pos(5, 0.7), config: { message: "{{nurture.text}}" } },
      ],
      edges: [
        { id: "e1", source: "start", target: "qualify" },
        { id: "e2", source: "qualify", target: "total" },
        { id: "e3", source: "total", target: "hot" },
        { id: "e4", source: "hot", sourceHandle: "hot", target: "book" },
        { id: "e5", source: "hot", sourceHandle: "nurture", target: "nurture" },
        { id: "e6", source: "nurture", target: "reply" },
      ],
    }),
};

const helpdesk: Template = {
  slug: "it-hr-helpdesk",
  name: "IT / HR Helpdesk",
  category: "HR/IT",
  description: "Routes employee questions to an IT or HR policy agent, and opens a ticket when it cannot help.",
  outcome: "Tickets avoided",
  minutes: 10,
  build: (p) =>
    flow(p, {
      triggers: [{ type: "chat", config: {} }],
      variables: [],
      nodes: [
        { id: "start", type: "start", label: "Chat", position: pos(0), config: {} },
        {
          id: "router",
          type: "agent",
          label: "Router",
          position: pos(1),
          config: {
            model: p.model,
            systemPrompt: "Decide which team an employee question is for: it, hr, or other.",
            userPrompt: "{{trigger.message}}",
            outputSchema: {
              type: "object",
              properties: { team: { type: "string", enum: ["it", "hr", "other"] } },
              required: ["team"],
            },
          },
        },
        {
          id: "route",
          type: "decision",
          label: "Team",
          position: pos(2),
          config: {
            outcomes: [
              { id: "it", condition: 'router.output.team == "it"' },
              { id: "hr", condition: 'router.output.team == "hr"' },
            ],
            defaultOutcome: "other",
          },
        },
        {
          id: "it_agent",
          type: "agent",
          label: "IT agent",
          position: pos(3, -1),
          config: {
            model: p.model,
            systemPrompt:
              "You are the IT helpdesk. Give short, step-by-step help for common issues (passwords, VPN, laptops, Wi-Fi).",
            userPrompt: "{{trigger.message}}",
          },
        },
        {
          id: "hr_agent",
          type: "agent",
          label: "HR policy agent",
          position: pos(3, 0),
          config: {
            model: p.model,
            systemPrompt:
              "You answer HR policy questions (leave, benefits, payroll dates) briefly. Point to HR for anything personal.",
            userPrompt: "{{trigger.message}}",
          },
        },
        {
          id: "it_done",
          type: "end",
          label: "IT answer",
          position: pos(4, -1),
          config: { message: "{{it_agent.text}}", outcome: "resolved" },
        },
        {
          id: "hr_done",
          type: "end",
          label: "HR answer",
          position: pos(4, 0),
          config: { message: "{{hr_agent.text}}", outcome: "resolved" },
        },
        {
          id: "ticket",
          type: "end",
          label: "Open a ticket",
          position: pos(3, 1),
          config: { message: "I've opened a ticket for the right team — they'll be in touch.", outcome: "escalated" },
        },
      ],
      edges: [
        { id: "e1", source: "start", target: "router" },
        { id: "e2", source: "router", target: "route" },
        { id: "e3", source: "route", sourceHandle: "it", target: "it_agent" },
        { id: "e4", source: "route", sourceHandle: "hr", target: "hr_agent" },
        { id: "e5", source: "route", sourceHandle: "other", target: "ticket" },
        { id: "e6", source: "it_agent", target: "it_done" },
        { id: "e7", source: "hr_agent", target: "hr_done" },
      ],
    }),
};

const invoiceProcessing: Template = {
  slug: "invoice-processing",
  name: "Invoice Processing",
  category: "Ops",
  description: "Extracts vendor, amount and due date from invoice text and flags large invoices for review.",
  outcome: "Hours saved",
  minutes: 10,
  build: (p) =>
    flow(p, {
      triggers: [{ type: "chat", config: {} }],
      variables: [{ name: "needs_review", type: "boolean", default: false }],
      nodes: [
        { id: "start", type: "start", label: "Invoice text", position: pos(0), config: {} },
        {
          id: "extract",
          type: "agent",
          label: "Extract fields",
          position: pos(1),
          config: {
            model: p.model,
            systemPrompt:
              "Extract invoice fields from the text. Use 0 for an unknown amount and an empty string for unknown text fields.",
            userPrompt: "{{trigger.message}}",
            outputSchema: {
              type: "object",
              properties: {
                vendor: { type: "string" },
                invoice_number: { type: "string" },
                amount: { type: "number" },
                due_date: { type: "string" },
              },
              required: ["vendor", "amount"],
            },
          },
        },
        {
          id: "check",
          type: "assignment",
          label: "Review rule",
          position: pos(2),
          config: { assignments: [{ variable: "needs_review", value: "extract.output.amount > 5000" }] },
        },
        {
          id: "route",
          type: "decision",
          label: "Over $5,000?",
          position: pos(3),
          config: { outcomes: [{ id: "review", condition: "needs_review" }], defaultOutcome: "auto" },
        },
        {
          id: "review",
          type: "end",
          label: "Needs review",
          position: pos(4, -0.5),
          config: {
            message: "Invoice from {{extract.output.vendor}} for {{extract.output.amount}} needs approval.",
            output: { vendor: "extract.output.vendor", amount: "extract.output.amount", status: '"review"' },
            outcome: "escalated",
          },
        },
        {
          id: "auto",
          type: "end",
          label: "Auto-approved",
          position: pos(4, 0.5),
          config: {
            message: "Invoice from {{extract.output.vendor}} for {{extract.output.amount}} was captured and approved.",
            output: { vendor: "extract.output.vendor", amount: "extract.output.amount", status: '"approved"' },
            outcome: "resolved",
          },
        },
      ],
      edges: [
        { id: "e1", source: "start", target: "extract" },
        { id: "e2", source: "extract", target: "check" },
        { id: "e3", source: "check", target: "route" },
        { id: "e4", source: "route", sourceHandle: "review", target: "review" },
        { id: "e5", source: "route", sourceHandle: "auto", target: "auto" },
      ],
    }),
};

export const templates: Template[] = [supportDeflection, orderStatus, leadQualification, helpdesk, invoiceProcessing];

export const getTemplate = (slug: string) => templates.find((t) => t.slug === slug);
