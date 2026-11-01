import type { Role } from "@agentflow/db";

/**
 * Fine-grained permissions for custom roles (H6). Each lists the lowest built-in role that has it, so the
 * built-in roles are presets. Members without a custom role are checked by role rank exactly as before.
 */
export const PERMISSIONS = {
  "flows.edit": { label: "Create and edit flows, test them, install templates", preset: "builder" },
  "flows.delete": { label: "Delete flows", preset: "builder" },
  "flows.publish": { label: "Publish and roll back flows", preset: "builder" },
  "flows.deploy": { label: "Widget, webhooks, A/B tests and publish rules", preset: "admin" },
  "flows.comment": { label: "Comment on nodes", preset: "reviewer" },
  "reviews.decide": { label: "Approve versions for release", preset: "reviewer" },
  "inbox.decide": { label: "Decide approvals and close handoffs", preset: "reviewer" },
  "knowledge.edit": { label: "Manage knowledge sources", preset: "builder" },
  "evals.run": { label: "Manage and run evals", preset: "builder" },
  "prompts.edit": { label: "Manage the prompt library", preset: "builder" },
  "connectors.manage": { label: "Add and remove connectors", preset: "admin" },
  "channels.manage": { label: "Connect Slack, Teams and WhatsApp", preset: "admin" },
  "keys.manage": { label: "Manage model keys", preset: "admin" },
  "members.manage": { label: "Invite members and assign roles", preset: "admin" },
  "settings.manage": { label: "Workspace settings (budgets, retention, notifications…)", preset: "admin" },
  "audit.view": { label: "View and export the audit log", preset: "admin" },
  "data.erase": { label: "View and erase customer data", preset: "admin" },
  "billing.manage": { label: "Manage billing", preset: "owner" },
} as const satisfies Record<string, { label: string; preset: Role }>;

export type Permission = keyof typeof PERMISSIONS;
export const permissionIds = Object.keys(PERMISSIONS) as Permission[];

const rank: Record<Role, number> = { viewer: 1, reviewer: 2, builder: 3, admin: 4, owner: 5 };

/** The permissions a built-in role has. */
export const presetPermissions = (role: Role): Permission[] =>
  permissionIds.filter((p) => rank[role] >= rank[PERMISSIONS[p].preset]);

/** Which permission each protected route needs (method + route pattern, as Fastify reports it). */
export const ROUTE_PERMISSIONS: Record<string, Permission> = {
  "POST /v1/flows": "flows.edit",
  "PUT /v1/flows/:id/draft": "flows.edit",
  "POST /v1/flows/:id/test-runs": "flows.edit",
  "POST /v1/runs/:id/messages": "flows.edit",
  "POST /v1/templates/:slug/install": "flows.edit",
  "POST /v1/connectors/:id/test": "flows.edit",
  "DELETE /v1/flows/:id": "flows.delete",
  "POST /v1/flows/:id/publish": "flows.publish",
  "POST /v1/flows/:id/versions/:versionId/rollback": "flows.publish",
  "PUT /v1/flows/:id/widget": "flows.deploy",
  "POST /v1/flows/:id/widget/identity-secret": "flows.deploy",
  "PUT /v1/flows/:id/settings": "flows.deploy",
  "POST /v1/flows/:id/webhook": "flows.deploy",
  "PATCH /v1/flows/:id/webhook": "flows.deploy",
  "DELETE /v1/flows/:id/webhook": "flows.deploy",
  "POST /v1/flows/:id/email-hook": "flows.deploy",
  "DELETE /v1/flows/:id/email-hook": "flows.deploy",
  "PUT /v1/flows/:id/ab-test": "flows.deploy",
  "DELETE /v1/flows/:id/ab-test": "flows.deploy",
  "POST /v1/flows/:id/ab-test/promote": "flows.deploy",
  "POST /v1/flows/:id/mcp": "flows.deploy",
  "DELETE /v1/flows/:id/mcp": "flows.deploy",
  "POST /v1/flows/:id/comments": "flows.comment",
  "PATCH /v1/flows/:id/comments/:commentId": "flows.comment",
  "DELETE /v1/flows/:id/comments/:commentId": "flows.comment",
  "POST /v1/reviews/:id/decide": "reviews.decide",
  "POST /v1/approvals/:id/decide": "inbox.decide",
  "POST /v1/handoffs/:id/close": "inbox.decide",
  "POST /v1/knowledge": "knowledge.edit",
  "POST /v1/knowledge/:id/sync": "knowledge.edit",
  "DELETE /v1/knowledge/:id": "knowledge.edit",
  "POST /v1/knowledge/index": "knowledge.edit",
  "POST /v1/flows/:id/evals": "evals.run",
  "POST /v1/evals/:id/cases": "evals.run",
  "POST /v1/evals/:id/cases/import": "evals.run",
  "POST /v1/evals/:id/cases/from-run": "evals.run",
  "DELETE /v1/evals/:id/cases/:caseId": "evals.run",
  "POST /v1/evals/:id/run": "evals.run",
  "POST /v1/prompts": "prompts.edit",
  "PUT /v1/prompts/:id": "prompts.edit",
  "DELETE /v1/prompts/:id": "prompts.edit",
  "POST /v1/connectors": "connectors.manage",
  "POST /v1/connectors/:id/refresh": "connectors.manage",
  "DELETE /v1/connectors/:id": "connectors.manage",
  "POST /v1/channels": "channels.manage",
  "DELETE /v1/channels/:id": "channels.manage",
  "POST /v1/provider-keys": "keys.manage",
  "DELETE /v1/provider-keys/:id": "keys.manage",
  "POST /v1/invites": "members.manage",
  "DELETE /v1/invites/:id": "members.manage",
  "PATCH /v1/members/:userId": "members.manage",
  "DELETE /v1/members/:userId": "members.manage",
  "POST /v1/roles": "members.manage",
  "PUT /v1/roles/:id": "members.manage",
  "DELETE /v1/roles/:id": "members.manage",
  "PUT /v1/workspace/settings": "settings.manage",
  "POST /v1/reports/send-test": "settings.manage",
  "GET /v1/audit": "audit.view",
  "GET /v1/end-users/:id": "data.erase",
  "DELETE /v1/end-users/:id": "data.erase",
  "POST /v1/billing/checkout": "billing.manage",
  "POST /v1/billing/portal": "billing.manage",
};
