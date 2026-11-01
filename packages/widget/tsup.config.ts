import { defineConfig } from "tsup";

// One self-contained script for <script src=".../widget.js" data-flow="…">.
export default defineConfig({
  entry: { widget: "src/index.ts" },
  format: "iife",
  target: "es2020",
  minify: true,
  clean: true,
  outExtension: () => ({ js: ".js" }),
});
