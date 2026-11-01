import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { newId } from "../ids";
import { users } from "./auth";
import { workspaces } from "./core";
import { flowVersions, flows, runs } from "./flows";

const createdAt = () => timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull();
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// --- Knowledge (H7) -------------------------------------------------------------------

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("ks")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<"text" | "url">().notNull(),
    /** For URL sources: the page to fetch on (re)sync. */
    uri: text("uri"),
    status: text("status").$type<"ready" | "syncing" | "error">().default("ready").notNull(),
    error: text("error"),
    lastSyncedAt: timestamp("last_synced_at", { mode: "date", withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("knowledge_sources_ws_idx").on(t.workspaceId)],
);

export const documents = pgTable(
  "documents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("doc")),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    uri: text("uri"),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("documents_source_idx").on(t.sourceId)],
);

/** Passages for retrieval. Full-text search today; an embedding column can be added behind the same Retriever. */
export const chunks = pgTable(
  "chunks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("chk")),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', content)`),
  },
  (t) => [index("chunks_ws_idx").on(t.workspaceId), index("chunks_tsv_idx").using("gin", t.tsv)],
);

// --- People in the loop (H5) --------------------------------------------------------------

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "expired"]);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("apr")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    message: text("message").notNull(),
    approverRole: text("approver_role").notNull(),
    status: approvalStatus("status").default("pending").notNull(),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_ws_status_idx").on(t.workspaceId, t.status)],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("hof")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    queue: text("queue").notNull(),
    summary: text("summary").notNull(),
    transcript: text("transcript").notNull(),
    status: text("status").$type<"open" | "closed">().default("open").notNull(),
    closedBy: text("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { mode: "date", withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("handoffs_ws_status_idx").on(t.workspaceId, t.status)],
);

// --- ROI (H4) -------------------------------------------------------------------------------

export const feedback = pgTable(
  "feedback",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("fb")),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** 1 = thumbs down, 5 = thumbs up. */
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("feedback_run_idx").on(t.runId)],
);

// --- Evals (H2) -------------------------------------------------------------------------------

export const evalDatasets = pgTable(
  "eval_datasets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("eds")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("eval_datasets_flow_idx").on(t.flowId)],
);

export type EvalExpectation = {
  /** Reply must contain this text (case-insensitive). */
  contains?: string;
  /** Run outcome must equal this tag. */
  outcome?: string;
  /** Plain-language criteria scored by an LLM judge (1–5, pass ≥ 4). */
  rubric?: string;
};

export const evalCases = pgTable(
  "eval_cases",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("ecs")),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    input: text("input").notNull(),
    expected: jsonb("expected").$type<EvalExpectation>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("eval_cases_dataset_idx").on(t.datasetId)],
);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("erun")),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    /** Hash of the draft that was evaluated, so the publish gate knows if the result is current. */
    draftHash: text("draft_hash").notNull(),
    status: text("status").$type<"running" | "completed" | "failed">().default("running").notNull(),
    passed: integer("passed").default(0).notNull(),
    total: integer("total").default(0).notNull(),
    passRate: real("pass_rate"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("eval_runs_flow_idx").on(t.flowId, t.createdAt)],
);

export const evalResults = pgTable(
  "eval_results",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("eres")),
    evalRunId: text("eval_run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    caseId: text("case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    reply: text("reply"),
    outcome: text("outcome"),
    scores: jsonb("scores").$type<{ name: string; pass: boolean; score?: number; reason?: string }[]>().notNull(),
    pass: boolean("pass").notNull(),
    latencyMs: integer("latency_ms"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  },
  (t) => [index("eval_results_run_idx").on(t.evalRunId)],
);

// --- Review before publish (H10) ---------------------------------------------------------------

export const reviews = pgTable(
  "reviews",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("rev")),
    flowVersionId: text("flow_version_id")
      .notNull()
      .references(() => flowVersions.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    reviewerId: text("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").$type<"pending" | "approved" | "rejected">().default("pending").notNull(),
    note: text("note"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("reviews_version_idx").on(t.flowVersionId)],
);

// --- Messaging channels (Slack, Teams, WhatsApp) -----------------------------------------------

export const channelConnections = pgTable(
  "channel_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("ch")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    type: text("type").$type<"slack" | "teams" | "whatsapp">().notNull(),
    name: text("name").notNull(),
    /** Non-secret settings, e.g. WhatsApp phone number id or the Teams app id. */
    config: jsonb("config").$type<Record<string, string>>().default({}).notNull(),
    /** Encrypted JSON: bot tokens, signing secrets, app passwords, access tokens. */
    encSecrets: text("enc_secrets").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("channel_connections_ws_idx").on(t.workspaceId)],
);

/** One external conversation (Slack thread, Teams conversation, WhatsApp number) ↔ one run. */
export const channelThreads = pgTable(
  "channel_threads",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channelConnections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    /** How to reach the conversation later (e.g. the Teams serviceUrl). */
    meta: jsonb("meta").$type<Record<string, string>>().default({}).notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("channel_threads_ext_idx").on(t.channelId, t.externalId)],
);
