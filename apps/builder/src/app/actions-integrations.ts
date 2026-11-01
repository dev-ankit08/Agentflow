"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const { current } = await requireWorkspace();
  return apiFetch<T>(path, { method, body, workspaceId: current.id });
}

/** Runs an API call and returns to `path`, carrying the API's error message if it failed. */
async function attempt(path: string, fn: () => Promise<unknown>, success?: string) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) redirect(`${path}?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  revalidatePath(path);
  if (success) redirect(`${path}?ok=${encodeURIComponent(success)}`);
}

// --- Channels ------------------------------------------------------------------------------

export async function addChannel(form: FormData) {
  const flowId = field(form, "flowId");
  const type = field(form, "type");
  const name = field(form, "name") || { slack: "Slack", teams: "Microsoft Teams", whatsapp: "WhatsApp" }[type] || type;
  const body =
    type === "slack"
      ? {
          type,
          flowId,
          name,
          secrets: { botToken: field(form, "botToken"), signingSecret: field(form, "signingSecret") },
        }
      : type === "teams"
        ? {
            type,
            flowId,
            name,
            config: { appId: field(form, "appId"), tenantId: field(form, "tenantId") || undefined },
            secrets: { appPassword: field(form, "appPassword") },
          }
        : {
            type,
            flowId,
            name,
            config: { phoneNumberId: field(form, "phoneNumberId") },
            secrets: {
              accessToken: field(form, "accessToken"),
              appSecret: field(form, "appSecret"),
              verifyToken: field(form, "verifyToken"),
            },
          };
  await attempt(
    `/flows/${flowId}/deploy`,
    () => call("/v1/channels", "POST", body),
    "Channel connected — copy its webhook URL into the platform",
  );
}

export async function deleteChannel(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(`/flows/${flowId}/deploy`, () => call(`/v1/channels/${field(form, "id")}`, "DELETE"));
}

// --- Billing --------------------------------------------------------------------------------

export async function startCheckout(form: FormData) {
  let url = "";
  await attempt("/billing", async () => {
    url = (await call<{ url: string }>("/v1/billing/checkout", "POST", { plan: field(form, "plan") })).url;
  });
  redirect(url);
}

export async function openBillingPortal() {
  let url = "";
  await attempt("/billing", async () => {
    url = (await call<{ url: string }>("/v1/billing/portal", "POST")).url;
  });
  redirect(url);
}
