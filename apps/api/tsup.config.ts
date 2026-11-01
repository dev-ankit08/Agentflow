import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so they are bundled; npm dependencies stay external.
export default defineConfig({
  entry: ["src/server.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  noExternal: [/^@agentflow\//],
});
