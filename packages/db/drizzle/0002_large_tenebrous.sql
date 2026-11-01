CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"config" jsonb NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"enc_credentials" text,
	"tool_catalog" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refreshed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connectors_ws_idx" ON "connectors" USING btree ("workspace_id");