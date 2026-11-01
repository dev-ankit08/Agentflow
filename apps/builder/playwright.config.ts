import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against a running stack (builder on 3100, API on 4000, mock model on 4010).
 * Locally they use the installed Edge browser; set E2E_CHANNEL="" to use Playwright's bundled Chromium (CI).
 */
const channel = process.env.E2E_CHANNEL ?? (process.env.CI ? "" : "msedge");

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    ...(channel ? { channel } : {}),
  },
});
