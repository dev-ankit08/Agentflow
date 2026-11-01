import { SCHEMA_VERSION, type FlowInput } from "./schema";

/** A new flow: Start → End. */
export function blankFlow(id: string, name: string): FlowInput {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    variables: [],
    triggers: [{ type: "chat", config: {} }],
    nodes: [
      { id: "start", type: "start", label: "Chat", position: { x: 0, y: 0 }, config: {} },
      { id: "done", type: "end", label: "Done", position: { x: 300, y: 0 }, config: { message: "Hello!" } },
    ],
    edges: [{ id: "e1", source: "start", target: "done" }],
    settings: { maxSteps: 25, maxCostUsd: 0.5 },
  };
}

/**
 * The "Order support" example from docs/03-architecture.md §5.2, using only nodes available today:
 * the Handoff node arrives in Phase 2, so "To human" is an End node tagged "escalated".
 */
export const orderSupportFlow: FlowInput = {
  schemaVersion: SCHEMA_VERSION,
  id: "flw_order_support",
  name: "Order support",
  variables: [
    { name: "order_id", type: "text" },
    { name: "order", type: "object" },
  ],
  triggers: [{ type: "chat", config: {} }],
  nodes: [
    { id: "start", type: "start", label: "Chat", position: { x: 0, y: 0 }, config: {} },
    {
      id: "triage",
      type: "agent",
      label: "Triage",
      position: { x: 250, y: 0 },
      config: {
        model: { provider: "anthropic", name: "claude-haiku-5-5" },
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
      position: { x: 500, y: 0 },
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
      position: { x: 750, y: -120 },
      config: { connectorId: "con_shopify", tool: "get_order", args: { order_id: "triage.output.order_id" } },
    },
    {
      id: "answer",
      type: "agent",
      label: "Answer",
      position: { x: 1000, y: -120 },
      config: {
        model: { provider: "openai", name: "gpt-5" },
        systemPrompt: "You are a friendly support agent. Use only the order data provided.",
        userPrompt: "Question: {{trigger.message}}\nOrder: {{lookup.result}}",
        // Deterministic context: only the guidance that fits this customer and order reaches the model.
        contextRules: [
          "- id: vip",
          '  when: user.plan == "vip"',
          "  include: The customer is VIP. Offer free express shipping on the next order.",
          "- id: status",
          "  switch: lookup.result.status",
          "  cases:",
          '    shipped: "The order has shipped. Give the delivery estimate ({{lookup.result.eta}}) and list the items."',
          "    processing: The order is being prepared. Say it usually ships within 2 business days.",
          "    delivered: The order was delivered. Ask whether everything arrived in good condition.",
          "  default: If the order wasn't found, apologise and ask the customer to check the order number.",
        ].join("\n"),
      },
    },
    {
      id: "handoff",
      type: "end",
      label: "To human",
      position: { x: 750, y: 120 },
      config: { message: "I'm passing you to a colleague who can help.", outcome: "escalated" },
    },
    {
      id: "done",
      type: "end",
      label: "Done",
      position: { x: 1250, y: -120 },
      config: { message: "{{answer.text}}", outcome: "resolved" },
    },
  ],
  edges: [
    { id: "e1", source: "start", target: "triage" },
    { id: "e2", source: "triage", target: "route" },
    { id: "e3", source: "route", sourceHandle: "status", target: "lookup" },
    { id: "e4", source: "route", sourceHandle: "refund", target: "handoff" },
    { id: "e5", source: "route", sourceHandle: "other", target: "handoff" },
    { id: "e6", source: "lookup", target: "answer" },
    { id: "e7", source: "answer", target: "done" },
  ],
  settings: { maxSteps: 25, maxCostUsd: 0.5 },
};
