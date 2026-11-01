import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so they are bundled; npm dependencies stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  noExternal: [/^@agentflow\//],
  // CommonJS dependencies of those packages (e.g. yaml) are bundled too and call require(), which ESM lacks.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
