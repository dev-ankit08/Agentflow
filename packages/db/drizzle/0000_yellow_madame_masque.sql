CREATE TYPE "public"."role" AS ENUM('owner', 'admin', 'builder', 'reviewer', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."flow_version_status" AS ENUM('draft', 'staging', 'live', 'archived');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'waiting_approval', 'waiting_input', 'completed', 'failed', 'handed_off');--> statement-breakpoint
CREATE TABLE "accounts" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "role" NOT NULL,
	"invited_by" text,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"enc_secret" text NOT NULL,
	"masked_secret" text NOT NULL,
	"base_url" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"version" integer NOT NULL,
	"json" jsonb NOT NULL,
	"status" "flow_version_status" DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"draft_json" jsonb NOT NULL,
	"live_version_id" text,
	"widget_key" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "flows_widget_key_unique" UNIQUE("widget_key")
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"status" text NOT NULL,
	"input_json" jsonb,
	"output_json" jsonb,
	"prompt_redacted" text,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(12, 6),
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"flow_version_id" text,
	"trigger_type" text NOT NULL,
	"end_user_id" text,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_flow_version_id_flow_versions_id_fk" FOREIGN KEY ("flow_version_id") REFERENCES "public"."flow_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_ws_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invites_email_idx" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_ws_email_idx" ON "invites" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_ws_idx" ON "memberships" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "provider_keys_ws_idx" ON "provider_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_versions_flow_version_idx" ON "flow_versions" USING btree ("flow_id","version");--> statement-breakpoint
CREATE INDEX "flows_ws_idx" ON "flows" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_step_idx" ON "run_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "runs_ws_idx" ON "runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_flow_idx" ON "runs" USING btree ("flow_id");