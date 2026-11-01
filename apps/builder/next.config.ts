import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// All apps share the repo-root .env.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  transpilePackages: ["@agentflow/ui", "@agentflow/db", "@agentflow/flow-schema", "@agentflow/expression-engine"],
  serverExternalPackages: ["postgres", "nodemailer"],
  // Standalone output (used by infra/Dockerfile) creates symlinks, which Windows blocks without Developer Mode.
  ...(process.env.NEXT_STANDALONE === "true" && {
    output: "standalone" as const,
    outputFileTracingRoot: resolve(process.cwd(), "../.."),
  }),
};

export default config;
