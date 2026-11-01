import { sql } from "drizzle-orm";
import { customType, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { newId } from "../ids";
import { users } from "./auth";
import { workspaces } from "./core";
import { flows } from "./flows";

const createdAt = () => timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull();
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// --- Long-term memory (H7) ----------------------------------------------------------------

/** Facts remembered about one end user (the signed-in visitor), searchable by full text. */
export const memories = pgTable(
  "memories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("mem")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").notNull(),
    fact: text("fact").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', fact)`),
    createdAt: createdAt(),
  },
  (t) => [index("memories_user_idx").on(t.workspaceId, t.endUserId), index("memories_tsv_idx").using("gin", t.tsv)],
);

// --- Governance (H6) ----------------------------------------------------------------------

/** Append-only record of configuration changes. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("aud")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_ws_idx").on(t.workspaceId, t.createdAt)],
);

// --- Collaboration (H10) ------------------------------------------------------------------

export const flowComments = pgTable(
  "flow_comments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("cmt")),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    resolvedAt: timestamp("resolved_at", { mode: "date", withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("flow_comments_flow_idx").on(t.flowId)],
);

// --- Prompt library ---------------------------------------------------------------------------

/** Reusable prompts shared across a workspace's agents. */
export const prompts = pgTable(
  "prompts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("prm")),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    body: text("body").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("prompts_ws_idx").on(t.workspaceId)],
);
