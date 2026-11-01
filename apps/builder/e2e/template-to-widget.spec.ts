import { expect, test } from "@playwright/test";

// The core promise end to end: install a template, publish it, and chat with it through the embedded widget.
// Needs the dev stack with the seeded demo workspace (Dev login, mock model key).
test("template → publish → widget chat", async ({ page }) => {
  const name = `E2E lead ${Date.now()}`;

  await page.goto("/login");
  await page.getByRole("button", { name: /Dev login/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  // Install the Lead Qualification template with the mock model.
  await page.goto("/templates");
  const card = page.locator("details", { has: page.locator('input[name="slug"][value="lead-qualification"]') });
  await card.getByText("Use this template").click();
  await card.getByLabel("Flow name").fill(name);
  await card.getByLabel("Provider").selectOption("openai_compatible");
  await card.getByLabel("Model").fill("mock-1");
  await card.getByRole("button", { name: "Create flow" }).click();
  await page.waitForURL(/\/flows\/flw_[^/]+$/);
  const flowId = page.url().split("/").pop()!;

  try {
    // Publish from the editor.
    await expect(page.getByText("✓ Valid")).toBeVisible();
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByText(/Published version 1/)).toBeVisible();

    // Open the sample customer website with the widget embedded.
    const widget = await (await page.request.get(`/api/v1/flows/${flowId}/widget`)).json();
    await page.goto(`/preview/${widget.widgetKey}`);
    await page.getByRole("button", { name: "Open chat" }).click();
    const botMessages = page.locator(".msg.bot:not(.typing)");
    const before = await botMessages.count(); // the welcome message, if any
    await page.locator("#af-input").fill("We have a budget of 50k and need this next month");
    await page.locator("#af-input").press("Enter");

    // The user's message and a new answer from the agent appear in the widget.
    await expect(page.locator(".msg.user").last()).toContainText("budget of 50k");
    await expect(botMessages).toHaveCount(before + 1);
    await expect(botMessages.last()).not.toBeEmpty();
  } finally {
    await page.request.delete(`/api/v1/flows/${flowId}`);
  }
});
