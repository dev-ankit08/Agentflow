ALTER TABLE "sessions" ALTER COLUMN "expires" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "emailVerified" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "verification_tokens" ALTER COLUMN "expires" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "last_used_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "accepted_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "provider_keys" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_keys" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "flow_versions" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flow_versions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "flows" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flows" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "flows" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flows" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "run_steps" ALTER COLUMN "started_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_steps" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "run_steps" ALTER COLUMN "ended_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "started_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "ended_at" SET DATA TYPE timestamp with time zone;