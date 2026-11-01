import { orderSupportFlow, type FlowInput } from "@agentflow/flow-schema";
import { createSecretStore, maskSecret } from "@agentflow/secret-store";
import {
  chunks,
  connectors,
  createDb,
  documents,
  flows,
  knowledgeSources,
  memberships,
  orgs,
  providerKeys,
  users,
  workspaces,
} from "../src";
import { loadRootEnv, requireDatabaseUrl } from "./env";

/**
 * Idempotent demo data: a user (used by the dev login), an org and workspace, a key for the local
 * mock model, the demo orders MCP connector, and a runnable "Order support" flow.
 * Start the mock model and demo MCP server with `pnpm demo`.
 */
const DEMO = {
  userId: "usr_demo",
  email: "demo@agentflow.local",
  orgId: "org_demo",
  workspaceId: "ws_demo",
  flowId: orderSupportFlow.id,
  connectorId: "con_demo_orders",
  providerKeyId: "pk_demo_mock",
} as const;

/** The documented example flow, wired to the mock model and the demo connector so it runs locally. */
function demoFlow(): FlowInput {
  const flow = structuredClone(orderSupportFlow);
  for (const node of flow.nodes) {
    if (node.type === "agent") node.config.model = { provider: "openai_compatible", name: "mock-1" };
    if (node.type === "mcp_tool") node.config.connectorId = DEMO.connectorId;
  }
  return flow;
}

const REFUND_FLOW_ID = "flw_demo_refunds";
const mock = { provider: "openai_compatible" as const, name: "mock-1" };
const at = (x: number, y = 0) => ({ x: x * 260, y: y * 150 });

/** Phase 2 showcase: guardrail → knowledge → triage → approval for refunds, cited answers otherwise. */
function refundFlow(): FlowInput {
  return {
    schemaVersion: 1,
    id: REFUND_FLOW_ID,
    name: "Refund assistant",
    variables: [],
    triggers: [{ type: "chat", config: {} }],
    nodes: [
      { id: "start", type: "start", label: "Chat", position: at(0), config: {} },
      {
        id: "safety",
        type: "guardrail",
        label: "Safety check",
        position: at(1),
        config: { checks: { pii: false, injection: true, blockedTopics: [] } },
      },
      { id: "kb", type: "knowledge", label: "Search policies", position: at(2), config: { topK: 3 } },
      {
        id: "triage",
        type: "agent",
        label: "Triage",
        position: at(3),
        config: {
          model: mock,
          systemPrompt: "Decide if the customer is asking for a refund or asking a question.",
          userPrompt: "{{trigger.message}}",
          outputSchema: {
            type: "object",
            properties: { intent: { type: "string", enum: ["refund", "question"] } },
            required: ["intent"],
          },
        },
      },
      {
        id: "route",
        type: "decision",
        label: "Refund?",
        position: at(4),
        config: {
          outcomes: [{ id: "refund", condition: 'triage.output.intent == "refund"' }],
          defaultOutcome: "question",
        },
      },
      {
        id: "approve",
        type: "approval",
        label: "Approve refund",
        position: at(5, -1),
        config: { message: "Refund request: {{trigger.message}}", approverRole: "reviewer", timeoutMinutes: 1440 },
      },
      {
        id: "approved",
        type: "end",
        label: "Approved",
        position: at(6, -1.6),
        config: {
          message: "Good news — your refund has been approved and will reach you within 5 business days.",
          outcome: "resolved",
        },
      },
      {
        id: "rejected",
        type: "end",
        label: "Rejected",
        position: at(6, -0.6),
        config: { message: "Sorry, we couldn't approve this refund. {{approve.note}}", outcome: "failed" },
      },
      {
        id: "answer",
        type: "agent",
        label: "Answer from policies",
        position: at(5, 1),
        config: {
          model: mock,
          systemPrompt: "Answer only from these passages and keep it short:\n{{kb.context}}",
          userPrompt: "{{trigger.message}}",
        },
      },
      {
        id: "answered",
        type: "end",
        label: "Answered",
        position: at(6, 1),
        config: { message: "{{answer.text}}", outcome: "resolved" },
      },
      { id: "human", type: "handoff", label: "To a person", position: at(2, 1.4), config: { queue: "support" } },
    ],
    edges: [
      { id: "e1", source: "start", target: "safety" },
      { id: "e2", source: "safety", sourceHandle: "pass", target: "kb" },
      { id: "e3", source: "safety", sourceHandle: "fail", target: "human" },
      { id: "e4", source: "kb", target: "triage" },
      { id: "e5", source: "triage", target: "route" },
      { id: "e6", source: "route", sourceHandle: "refund", target: "approve" },
      { id: "e7", source: "route", sourceHandle: "question", target: "answer" },
      { id: "e8", source: "approve", sourceHandle: "approved", target: "approved" },
      { id: "e9", source: "approve", sourceHandle: "rejected", target: "rejected" },
      { id: "e10", source: "approve", sourceHandle: "timeout", target: "human" },
      { id: "e11", source: "answer", target: "answered" },
    ],
    settings: { maxSteps: 25, maxCostUsd: 0.5 },
  };
}

const POLICIES = `Returns are accepted within 30 days of delivery, as long as items are unused and in their original packaging.

Refunds are issued to the original payment method within 5 business days of approval.

Shipping is free on orders over $50. Standard delivery takes 3-5 business days; express delivery takes 1-2 business days.

Support is available Monday to Friday, 9am to 6pm.`;

const demoTools = [
  {
    name: "get_order",
    description: "Look up an order by its id. Returns status, delivery estimate, total and items.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string", description: "Order id, e.g. 1042" } },
      required: ["order_id"],
    },
    mode: "read" as const,
  },
  {
    name: "list_orders",
    description: "List all order ids with their status.",
    inputSchema: { type: "object", properties: {} },
    mode: "read" as const,
  },
  {
    name: "request_refund",
    description: "Open a refund request for an order.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" }, reason: { type: "string" } },
      required: ["order_id"],
    },
    mode: "write" as const,
  },
];

loadRootEnv();
const { db, close } = createDb(requireDatabaseUrl(), { max: 1 });

try {
  await db
    .insert(users)
    .values({ id: DEMO.userId, email: DEMO.email, name: "Demo User", emailVerified: new Date() })
    .onConflictDoNothing();
  await db.insert(orgs).values({ id: DEMO.orgId, name: "Demo Org" }).onConflictDoNothing();
  await db
    .insert(workspaces)
    .values({ id: DEMO.workspaceId, orgId: DEMO.orgId, name: "Default" })
    .onConflictDoNothing();
  await db
    .insert(memberships)
    .values({ userId: DEMO.userId, workspaceId: DEMO.workspaceId, role: "owner" })
    .onConflictDoNothing();

  if (process.env.SECRETS_MASTER_KEY) {
    const secrets = createSecretStore(process.env.SECRETS_MASTER_KEY);
    await db
      .insert(providerKeys)
      .values({
        id: DEMO.providerKeyId,
        workspaceId: DEMO.workspaceId,
        provider: "openai_compatible",
        label: "Local mock model (pnpm demo)",
        encSecret: secrets.encrypt("mock"),
        maskedSecret: maskSecret("mock"),
        baseUrl: "http://localhost:4010/v1",
        createdBy: DEMO.userId,
      })
      .onConflictDoNothing();
  }

  await db
    .insert(connectors)
    .values({
      id: DEMO.connectorId,
      workspaceId: DEMO.workspaceId,
      name: "Demo orders (pnpm demo)",
      transport: "http",
      config: { transport: "http", url: "http://localhost:4020/mcp" },
      toolCatalog: demoTools,
      refreshedAt: new Date(),
      createdBy: DEMO.userId,
    })
    .onConflictDoNothing();

  // Re-seeding resets the demo flow to its runnable form.
  const draft = demoFlow();
  await db
    .insert(flows)
    .values({
      id: DEMO.flowId,
      workspaceId: DEMO.workspaceId,
      name: draft.name,
      draftJson: draft,
      createdBy: DEMO.userId,
    })
    .onConflictDoUpdate({ target: flows.id, set: { draftJson: draft, updatedAt: new Date() } });

  const refunds = refundFlow();
  await db
    .insert(flows)
    .values({
      id: REFUND_FLOW_ID,
      workspaceId: DEMO.workspaceId,
      name: refunds.name,
      draftJson: refunds,
      createdBy: DEMO.userId,
    })
    .onConflictDoUpdate({ target: flows.id, set: { draftJson: refunds, updatedAt: new Date() } });

  const [source] = await db
    .insert(knowledgeSources)
    .values({
      id: "ks_demo_policies",
      workspaceId: DEMO.workspaceId,
      name: "Store policies",
      type: "text",
      lastSyncedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (source) {
    const [doc] = await db
      .insert(documents)
      .values({ sourceId: source.id, title: "Store policies", contentHash: "seed" })
      .returning();
    await db.insert(chunks).values(
      POLICIES.split(/\n\s*\n/).map((content, position) => ({
        documentId: doc!.id,
        workspaceId: DEMO.workspaceId,
        position,
        content,
      })),
    );
  }

  console.log(`✓ Seeded demo data (login: ${DEMO.email}). Run \`pnpm demo\` for the mock model and demo MCP server.`);
} finally {
  await close();
}
