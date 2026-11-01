ALTER TYPE "public"."run_status" ADD VALUE 'waiting_timer' BEFORE 'completed';--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"author_id" text,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"end_user_id" text NOT NULL,
	"fact" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', fact)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_comments" ADD CONSTRAINT "flow_comments_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_comments" ADD CONSTRAINT "flow_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_ws_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "flow_comments_flow_idx" ON "flow_comments" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("workspace_id","end_user_id");--> statement-breakpoint
CREATE INDEX "memories_tsv_idx" ON "memories" USING gin ("tsv");