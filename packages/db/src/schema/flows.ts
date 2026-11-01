import type { FlowInput } from "@agentflow/flow-schema";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { newId } from "../ids";
import { users } from "./auth";
import { workspaces } from "./core";

const createdAt = () => timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull();

export const flows = pgTable(
  "flows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("flw")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    draftJson: jsonb("draft_json").$type<FlowInput>().notNull(),
    liveVersionId: text("live_version_id"),
    widgetKey: text("widget_key")
      .notNull()
      .unique()
      .$defaultFn(() => newId("wk")),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("flows_ws_idx").on(t.workspaceId)],
);

export const flowVersionStatus = pgEnum("flow_version_status", ["draft", "staging", "live", "archived"]);

export const flowVersions = pgTable(
  "flow_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("fv")),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    json: jsonb("json").$type<FlowInput>().notNull(),
    status: flowVersionStatus("status").default("draft").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("flow_versions_flow_version_idx").on(t.flowId, t.version)],
);

export const runStatus = pgEnum("run_status", [
  "running",
  "waiting_approval",
  "waiting_input",
  "waiting_timer",
  "completed",
  "failed",
  "handed_off",
]);

export const runs = pgTable(
  "runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("run")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    flowVersionId: text("flow_version_id").references(() => flowVersions.id, { onDelete: "set null" }),
    triggerType: text("trigger_type").notNull(),
    endUserId: text("end_user_id"),
    status: runStatus("status").default("running").notNull(),
    state: jsonb("state").$type<Record<string, unknown>>().default({}).notNull(),
    sandbox: boolean("sandbox").default(false).notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).default("0").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("runs_ws_idx").on(t.workspaceId, t.startedAt), index("runs_flow_idx").on(t.flowId)],
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("stp")),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    nodeId: text("node_id").notNull(),
    nodeType: text("node_type").notNull(),
    status: text("status").notNull(),
    inputJson: jsonb("input_json"),
    outputJson: jsonb("output_json"),
    promptRedacted: text("prompt_redacted"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    error: text("error"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
  },
  (t) => [uniqueIndex("run_steps_run_step_idx").on(t.runId, t.stepIndex)],
);
