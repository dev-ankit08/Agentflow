import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { newId } from "../ids";
import { users } from "./auth";

export const roles = ["owner", "admin", "builder", "reviewer", "viewer"] as const;
export const roleEnum = pgEnum("role", roles);
export type Role = (typeof roles)[number];

export type WorkspaceSettings = {
  /** Monthly AI limits (H11); either may be set. */
  budget?: { monthlyUsd?: number; monthlyTokens?: number };
  /** Human baseline for the ROI dashboard (H4). */
  roi?: { costPerConversation: number; minutesPerConversation: number };
  /** Data retention (H6): delete runs after `days`; zeroRetention keeps no prompts, outputs or transcripts. */
  retention?: { days?: number; zeroRetention?: boolean };
  /** Embedding model for semantic knowledge search (H7); full-text search only when unset. */
  embedding?: { provider: "openai" | "azure_openai" | "openai_compatible"; name: string };
};

const createdAt = () => timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull();

export const orgs = pgTable("orgs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("org")),
  name: text("name").notNull(),
  plan: text("plan").default("free").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("ws")),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    settings: jsonb("settings").$type<WorkspaceSettings>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("workspaces_org_idx").on(t.orgId)],
);

export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_user_ws_idx").on(t.userId, t.workspaceId)],
);

export const invites = pgTable(
  "invites",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("inv")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: roleEnum("role").notNull(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invites_email_idx").on(t.email), uniqueIndex("invites_ws_email_idx").on(t.workspaceId, t.email)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("key")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hash: text("hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_ws_idx").on(t.workspaceId)],
);

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("pk")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    encSecret: text("enc_secret").notNull(),
    maskedSecret: text("masked_secret").notNull(),
    baseUrl: text("base_url"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("provider_keys_ws_idx").on(t.workspaceId)],
);

export type ConnectorToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mode: "read" | "write" | "destructive";
};

/** MCP servers (and later REST APIs) a workspace has connected. Credentials are encrypted JSON. */
export const connectors = pgTable(
  "connectors",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("con")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    transport: text("transport").$type<"http" | "stdio">().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    authType: text("auth_type").$type<"none" | "bearer" | "header">().default("none").notNull(),
    encCredentials: text("enc_credentials"),
    toolCatalog: jsonb("tool_catalog").$type<ConnectorToolInfo[]>().default([]).notNull(),
    refreshedAt: timestamp("refreshed_at", { mode: "date", withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("connectors_ws_idx").on(t.workspaceId)],
);
