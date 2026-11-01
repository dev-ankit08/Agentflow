CREATE TABLE "response_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"context_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"input" text NOT NULL,
	"embedding" real[],
	"answer" jsonb NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "response_cache" ADD CONSTRAINT "response_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_cache" ADD CONSTRAINT "response_cache_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "response_cache_key_idx" ON "response_cache" USING btree ("workspace_id","flow_id","node_id","context_hash","input_hash");--> statement-breakpoint
CREATE INDEX "response_cache_lookup_idx" ON "response_cache" USING btree ("workspace_id","flow_id","node_id","context_hash");