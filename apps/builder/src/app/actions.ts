"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { ApiError, apiFetch } from "@/lib/api";
import { WORKSPACE_COOKIE, requireWorkspace } from "@/lib/context";

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
  if (success) redirect(`${path}?ok=${encodeURIComponent(success)}`);
}

// --- Auth -------------------------------------------------------------------

export async function signInWithEmail(form: FormData) {
  await signIn("nodemailer", { email: field(form, "email"), redirectTo: "/" });
}
export async function signInWithGoogle() {
  await signIn("google", { redirectTo: "/" });
}
export async function signInDev() {
  await signIn("dev", { redirectTo: "/" });
}
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

// --- Workspaces -------------------------------------------------------------

export async function createOrg(form: FormData) {
  let workspaceId = "";
  await attempt("/onboarding", async () => {
    const ws = await apiFetch<{ id: string }>("/v1/orgs", {
      method: "POST",
      body: { orgName: field(form, "orgName"), workspaceName: field(form, "workspaceName") || undefined },
    });
    workspaceId = ws.id;
  });
  (await cookies()).set(WORKSPACE_COOKIE, workspaceId, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}

export async function switchWorkspace(form: FormData) {
  (await cookies()).set(WORKSPACE_COOKIE, field(form, "workspaceId"), { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}

// --- Flows ------------------------------------------------------------------

export async function createFlow(form: FormData) {
  const { current } = await requireWorkspace();
  let id = "";
  await attempt("/flows", async () => {
    const flow = await apiFetch<{ id: string }>("/v1/flows", {
      method: "POST",
      workspaceId: current.id,
      body: { name: field(form, "name") },
    });
    id = flow.id;
  });
  redirect(`/flows/${id}`);
}

export async function deleteFlow(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt("/flows", () =>
    apiFetch(`/v1/flows/${field(form, "id")}`, { method: "DELETE", workspaceId: current.id }),
  );
  redirect("/flows");
}

// --- Members ----------------------------------------------------------------

export async function inviteMember(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt(
    "/settings",
    () =>
      apiFetch("/v1/invites", {
        method: "POST",
        workspaceId: current.id,
        body: { email: field(form, "email"), role: field(form, "role") },
      }),
    "Invitation saved",
  );
}

export async function cancelInvite(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt("/settings", () =>
    apiFetch(`/v1/invites/${field(form, "id")}`, { method: "DELETE", workspaceId: current.id }),
  );
}

export async function changeRole(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt(
    "/settings",
    () =>
      apiFetch(`/v1/members/${field(form, "userId")}`, {
        method: "PATCH",
        workspaceId: current.id,
        body: { role: field(form, "role") },
      }),
    "Role updated",
  );
}

export async function removeMember(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt("/settings", () =>
    apiFetch(`/v1/members/${field(form, "userId")}`, { method: "DELETE", workspaceId: current.id }),
  );
}

// --- Provider keys ------------------------------------------------------------

export async function addProviderKey(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt(
    "/settings",
    () =>
      apiFetch("/v1/provider-keys", {
        method: "POST",
        workspaceId: current.id,
        body: {
          provider: field(form, "provider"),
          label: field(form, "label"),
          secret: field(form, "secret"),
          baseUrl: field(form, "baseUrl") || undefined,
        },
      }),
    "Key saved",
  );
}

export async function deleteProviderKey(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt("/settings", () =>
    apiFetch(`/v1/provider-keys/${field(form, "id")}`, { method: "DELETE", workspaceId: current.id }),
  );
}

// --- Connectors -------------------------------------------------------------------

export async function addConnector(form: FormData) {
  const { current } = await requireWorkspace();
  const authType = field(form, "authType");
  const auth =
    authType === "bearer"
      ? { type: "bearer", token: field(form, "token") }
      : authType === "header"
        ? { type: "header", header: field(form, "header"), value: field(form, "token") }
        : { type: "none" };
  await attempt(
    "/connectors",
    () =>
      apiFetch("/v1/connectors", {
        method: "POST",
        workspaceId: current.id,
        body: { name: field(form, "name"), config: { transport: "http", url: field(form, "url") }, auth },
      }),
    "Connector added",
  );
}

export async function refreshConnector(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt(
    "/connectors",
    () => apiFetch(`/v1/connectors/${field(form, "id")}/refresh`, { method: "POST", workspaceId: current.id }),
    "Tools refreshed",
  );
}

export async function deleteConnector(form: FormData) {
  const { current } = await requireWorkspace();
  await attempt("/connectors", () =>
    apiFetch(`/v1/connectors/${field(form, "id")}`, { method: "DELETE", workspaceId: current.id }),
  );
}

// --- Templates ----------------------------------------------------------------------

export async function installTemplate(form: FormData) {
  const { current } = await requireWorkspace();
  let id = "";
  await attempt("/templates", async () => {
    const flow = await apiFetch<{ id: string }>(`/v1/templates/${field(form, "slug")}/install`, {
      method: "POST",
      workspaceId: current.id,
      body: {
        name: field(form, "name") || undefined,
        model: { provider: field(form, "provider"), name: field(form, "model") },
        connectorId: field(form, "connectorId") || undefined,
      },
    });
    id = flow.id;
  });
  redirect(`/flows/${id}`);
}

// --- Deploy ---------------------------------------------------------------------------

export async function rollbackVersion(form: FormData) {
  const { current } = await requireWorkspace();
  const flowId = field(form, "flowId");
  await attempt(
    `/flows/${flowId}/deploy`,
    () =>
      apiFetch(`/v1/flows/${flowId}/versions/${field(form, "versionId")}/rollback`, {
        method: "POST",
        workspaceId: current.id,
      }),
    "Rolled back — that version is live again and restored as the draft",
  );
}

export async function saveWidget(form: FormData) {
  const { current } = await requireWorkspace();
  const flowId = field(form, "flowId");
  const lines = (name: string) =>
    field(form, name)
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  await attempt(
    `/flows/${flowId}/deploy`,
    () =>
      apiFetch(`/v1/flows/${flowId}/widget`, {
        method: "PUT",
        workspaceId: current.id,
        body: {
          title: field(form, "title"),
          welcome: field(form, "welcome"),
          color: field(form, "color"),
          allowedOrigins: lines("allowedOrigins"),
          quickReplies: lines("quickReplies"),
        },
      }),
    "Widget settings saved",
  );
}
