"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { requireWorkspace } from "@/lib/context";

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const optionalNumber = (form: FormData, name: string) => {
  const v = field(form, name);
  return v === "" ? undefined : Number(v);
};

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

async function call(path: string, method: string, body?: unknown) {
  const { current } = await requireWorkspace();
  return apiFetch(path, { method, body, workspaceId: current.id });
}

// --- Knowledge ----------------------------------------------------------------------------

export async function addKnowledgeText(form: FormData) {
  await attempt(
    "/knowledge",
    () => call("/v1/knowledge", "POST", { type: "text", name: field(form, "name"), content: field(form, "content") }),
    "Document added",
  );
}

export async function addKnowledgeUrl(form: FormData) {
  await attempt(
    "/knowledge",
    () =>
      call("/v1/knowledge", "POST", { type: "url", uri: field(form, "uri"), name: field(form, "name") || undefined }),
    "Web page added",
  );
}

export async function syncKnowledge(form: FormData) {
  await attempt("/knowledge", () => call(`/v1/knowledge/${field(form, "id")}/sync`, "POST"), "Re-synced");
}

export async function deleteKnowledge(form: FormData) {
  await attempt("/knowledge", () => call(`/v1/knowledge/${field(form, "id")}`, "DELETE"));
}

// --- Inbox ----------------------------------------------------------------------------------

// The clicked button's name/value is not part of a server action's FormData, so each button gets its own action.
export async function approveRequest(form: FormData) {
  form.set("decision", "approve");
  await decideApproval(form);
}
export async function rejectRequest(form: FormData) {
  form.set("decision", "reject");
  await decideApproval(form);
}
export async function approveReview(form: FormData) {
  form.set("decision", "approve");
  await decideReview(form);
}
export async function rejectReview(form: FormData) {
  form.set("decision", "reject");
  await decideReview(form);
}

async function decideApproval(form: FormData) {
  const decision = field(form, "decision");
  await attempt(
    "/inbox",
    () =>
      call(`/v1/approvals/${field(form, "id")}/decide`, "POST", { decision, note: field(form, "note") || undefined }),
    decision === "approve" ? "Approved — the conversation continued" : "Rejected — the conversation continued",
  );
}

export async function closeHandoff(form: FormData) {
  await attempt("/inbox", () => call(`/v1/handoffs/${field(form, "id")}/close`, "POST"), "Marked as handled");
}

// --- Evals ------------------------------------------------------------------------------------

export async function createDataset(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(`/flows/${flowId}/evals`, () =>
    call(`/v1/flows/${flowId}/evals`, "POST", { name: field(form, "name") }),
  );
}

export async function addCase(form: FormData) {
  const flowId = field(form, "flowId");
  const expected = {
    contains: field(form, "contains") || undefined,
    outcome: field(form, "outcome") || undefined,
    rubric: field(form, "rubric") || undefined,
  };
  await attempt(`/flows/${flowId}/evals`, () =>
    call(`/v1/evals/${field(form, "datasetId")}/cases`, "POST", { input: field(form, "input"), expected }),
  );
}

export async function deleteCase(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(`/flows/${flowId}/evals`, () =>
    call(`/v1/evals/${field(form, "datasetId")}/cases/${field(form, "caseId")}`, "DELETE"),
  );
}

export async function runEvals(form: FormData) {
  const flowId = field(form, "flowId");
  let runId = "";
  await attempt(`/flows/${flowId}/evals`, async () => {
    const res = (await call(`/v1/evals/${field(form, "datasetId")}/run`, "POST", {})) as { id: string };
    runId = res.id;
  });
  redirect(`/flows/${flowId}/evals?run=${runId}`);
}

export async function saveGate(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(
    `/flows/${flowId}/evals`,
    () =>
      call(`/v1/flows/${flowId}/settings`, "PUT", {
        publishGate: {
          enabled: form.get("enabled") === "on",
          minPassRate: (optionalNumber(form, "minPassRate") ?? 90) / 100,
        },
      }),
    "Publish gate saved",
  );
}

export async function addCaseFromRun(form: FormData) {
  const runId = field(form, "runId");
  await attempt(
    `/runs/${runId}`,
    () => call(`/v1/evals/${field(form, "datasetId")}/cases/from-run`, "POST", { runId }),
    "Added to the eval dataset",
  );
}

// --- Review and settings -----------------------------------------------------------------------

export async function saveReviewSetting(form: FormData) {
  const flowId = field(form, "flowId");
  await attempt(
    `/flows/${flowId}/deploy`,
    () => call(`/v1/flows/${flowId}/settings`, "PUT", { requireReview: form.get("requireReview") === "on" }),
    "Review setting saved",
  );
}

async function decideReview(form: FormData) {
  const flowId = field(form, "flowId");
  const decision = field(form, "decision");
  await attempt(
    `/flows/${flowId}/deploy`,
    () => call(`/v1/reviews/${field(form, "id")}/decide`, "POST", { decision, note: field(form, "note") || undefined }),
    decision === "approve" ? "Approved — the version is live" : "Changes rejected",
  );
}

export async function saveWorkspaceSettings(form: FormData) {
  const usd = optionalNumber(form, "monthlyUsd");
  const tokens = optionalNumber(form, "monthlyTokens");
  await attempt(
    "/settings",
    () =>
      call("/v1/workspace/settings", "PUT", {
        budget: usd || tokens ? { monthlyUsd: usd || undefined, monthlyTokens: tokens || undefined } : null,
        roi: {
          costPerConversation: optionalNumber(form, "costPerConversation") ?? 6,
          minutesPerConversation: optionalNumber(form, "minutesPerConversation") ?? 8,
        },
      }),
    "Budget and ROI baseline saved",
  );
}
