CREATE TABLE "channel_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enc_secrets" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_threads" (
	"channel_id" text NOT NULL,
	"external_id" text NOT NULL,
	"run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_channel_id_channel_connections_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_connections_ws_idx" ON "channel_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_threads_ext_idx" ON "channel_threads" USING btree ("channel_id","external_id");