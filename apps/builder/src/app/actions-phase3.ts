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
