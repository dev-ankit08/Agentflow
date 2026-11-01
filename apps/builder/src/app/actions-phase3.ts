"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Runs an API call and returns to `path`, carrying the API's error message if it failed. */
async function attempt(path: string, fn: () => Promise<unknown>, success?: string) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) redirect(`${path}?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  revalidatePath(path);
  if (success) redirect(`${path}${path.includes("?") ? "&" : "?"}ok=${encodeURIComponent(success)}`);
}

async function call(path: string, method: string, body?: unknown) {
  const { current } = await requireWorkspace();
  return apiFetch(path, { method, body, workspaceId: current.id });
}

export async function saveRetention(form: FormData) {
  const days = field(form, "days");
  await attempt(
    "/settings",
    () =>
      call("/v1/workspace/settings", "PUT", {
        retention: { days: days ? Number(days) : undefined, zeroRetention: form.get("zeroRetention") === "on" },
      }),
    "Data retention saved",
  );
}

export async function deleteEndUser(form: FormData) {
  const id = field(form, "endUserId");
  await attempt(
    "/settings",
    () => call(`/v1/end-users/${encodeURIComponent(id)}`, "DELETE"),
    `Deleted all stored data for ${id}`,
  );
}

export async function startAbTest(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(
    `/flows/${flowId}/deploy`,
    () =>
      call(`/v1/flows/${flowId}/ab-test`, "PUT", {
        versionId: field(form, "versionId"),
        percent: Number(field(form, "percent")),
      }),
    "A/B test started",
  );
}

export async function stopAbTest(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(`/flows/${flowId}/deploy`, () => call(`/v1/flows/${flowId}/ab-test`, "DELETE"), "A/B test stopped");
}

export async function promoteAbTest(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(
    `/flows/${flowId}/deploy`,
    () => call(`/v1/flows/${flowId}/ab-test/promote`, "POST"),
    "The challenger is now the live version",
  );
}

export async function saveEmbedding(form: FormData) {
  const provider = field(form, "provider");
  const name = field(form, "name");
  await attempt(
    "/settings",
    () => call("/v1/workspace/settings", "PUT", { embedding: provider && name ? { provider, name } : null }),
    provider && name ? "Embedding model saved; your knowledge is being indexed" : "Semantic search turned off",
  );
}

export async function indexKnowledgeNow() {
  await attempt("/settings", () => call("/v1/knowledge/index", "POST"), "Knowledge indexed");
}

export async function saveMemoryExtraction(form: FormData) {
  const enabled = form.get("enabled") === "on";
  await attempt(
    "/settings",
    () =>
      call("/v1/workspace/settings", "PUT", {
        memoryExtraction: {
          enabled,
          model: { provider: field(form, "provider"), name: field(form, "model") },
          idleMinutes: Number(field(form, "idleMinutes")) || 30,
        },
      }),
    enabled ? "Customers' conversations will be remembered" : "Background memory turned off",
  );
}

export async function saveNotifications(form: FormData) {
  const url = field(form, "slackWebhookUrl");
  await attempt(
    "/settings",
    () =>
      call("/v1/workspace/settings", "PUT", {
        notifications: {
          emailApprovers: form.get("emailApprovers") === "on",
          // Empty keeps the saved webhook; "Remove" clears it.
          ...(form.get("removeSlack") === "on" ? { slackWebhookUrl: null } : url ? { slackWebhookUrl: url } : {}),
        },
      }),
    "Approval notifications saved",
  );
}

export async function importEvalCases(form: FormData) {
  const flowId = field(form, "flowId");
  const file = form.get("file");
  const csv = file instanceof File ? await file.text() : "";
  let summary = "";
  await attempt(`/flows/${flowId}/evals`, async () => {
    if (!csv.trim()) throw new ApiError(400, "Choose a CSV file to import");
    const res = await call(`/v1/evals/${field(form, "datasetId")}/cases/import`, "POST", { csv });
    const { added, skipped } = res as { added: number; skipped: number };
    summary = `Imported ${added} case${added === 1 ? "" : "s"}${skipped ? ` (${skipped} rows without an input skipped)` : ""}`;
  });
  redirect(`/flows/${flowId}/evals?ok=${encodeURIComponent(summary)}`);
}

export async function savePrompt(form: FormData) {
  const id = field(form, "id");
  const body = {
    name: field(form, "name"),
    description: field(form, "description") || undefined,
    body: String(form.get("body") ?? ""),
  };
  await attempt(
    "/prompts",
    () => (id ? call(`/v1/prompts/${id}`, "PUT", body) : call("/v1/prompts", "POST", body)),
    id ? "Prompt saved" : "Prompt added to the library",
  );
}

export async function deletePrompt(form: FormData) {
  await attempt("/prompts", () => call(`/v1/prompts/${field(form, "id")}`, "DELETE"), "Prompt deleted");
}

export async function saveCache(form: FormData) {
  const enabled = form.get("enabled") === "on";
  await attempt(
    "/settings",
    () =>
      call("/v1/workspace/settings", "PUT", {
        cache: {
          enabled,
          ttlHours: Number(field(form, "ttlHours")) || 24,
          similar: form.get("similar") === "on",
        },
      }),
    enabled ? "Response cache on" : "Response cache off",
  );
}

export async function saveReports(form: FormData) {
  const enabled = form.get("enabled") === "on";
  const extraRecipients = field(form, "extraRecipients")
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  await attempt(
    "/settings",
    () =>
      call("/v1/workspace/settings", "PUT", {
        reports: {
          enabled,
          weekday: Number(field(form, "weekday")),
          hourUtc: Number(field(form, "hourUtc")),
          extraRecipients,
        },
      }),
    enabled ? "Weekly report scheduled" : "Weekly report turned off",
  );
}

export async function sendTestReport() {
  await attempt("/settings", () => call("/v1/reports/send-test", "POST"), "Test report sent to your email");
}
