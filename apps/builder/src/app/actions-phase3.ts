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
