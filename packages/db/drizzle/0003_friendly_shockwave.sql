CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"message" text NOT NULL,
	"approver_role" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"note" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"uri" text,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"input" text NOT NULL,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" text PRIMARY KEY NOT NULL,
	"eval_run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"run_id" text,
	"reply" text,
	"outcome" text,
	"scores" jsonb NOT NULL,
	"pass" boolean NOT NULL,
	"latency_ms" integer,
	"cost_usd" numeric(12, 6)
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"draft_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"pass_rate" real,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"queue" text NOT NULL,
	"summary" text NOT NULL,
	"transcript" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"uri" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_version_id" text NOT NULL,
	"requested_by" text,
	"reviewer_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_flow_version_id_flow_versions_id_fk" FOREIGN KEY ("flow_version_id") REFERENCES "public"."flow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_ws_status_idx" ON "approvals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "chunks_ws_idx" ON "chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "eval_cases_dataset_idx" ON "eval_cases" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "eval_datasets_flow_idx" ON "eval_datasets" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "eval_results_run_idx" ON "eval_results" USING btree ("eval_run_id");--> statement-breakpoint
CREATE INDEX "eval_runs_flow_idx" ON "eval_runs" USING btree ("flow_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_run_idx" ON "feedback" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "handoffs_ws_status_idx" ON "handoffs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_sources_ws_idx" ON "knowledge_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "reviews_version_idx" ON "reviews" USING btree ("flow_version_id");