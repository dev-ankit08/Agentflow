import { notFound, redirect } from "next/navigation";
import type { FlowInput } from "@agentflow/flow-schema";
import { auth } from "@/auth";
import { FlowEditor } from "@/components/editor/flow-editor";
import type { FlowSummary, SourceSummary } from "@/components/editor/inspector-extra";
import type { ConnectorSummary } from "@/components/editor/model";
import { ApiError, apiFetch } from "@/lib/api";
import { can, getContext } from "@/lib/context";

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())?.user) redirect("/login");
  const { current } = await getContext();
  if (!current) redirect("/onboarding");
  const { id } = await params;

  let flow: { id: string; draftJson: FlowInput; updatedAt: string };
  try {
    flow = await apiFetch(`/v1/flows/${id}`, { workspaceId: current.id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const ws = { workspaceId: current.id };
  const [{ connectors }, { providers }, versions, { sources }, { flows }] = await Promise.all([
    apiFetch<{ connectors: ConnectorSummary[] }>("/v1/connectors", ws),
    apiFetch<{ providers: string[] }>("/v1/providers", ws),
    apiFetch<{ versions: { id: string; version: number; status: string }[] }>(`/v1/flows/${id}/versions`, ws),
    apiFetch<{ sources: SourceSummary[] }>("/v1/knowledge", ws),
    apiFetch<{ flows: FlowSummary[] }>("/v1/flows", ws),
  ]);
  const live = versions.versions.find((v) => v.status === "live");

  return (
    <FlowEditor
      flowId={flow.id}
      initial={flow.draftJson}
      liveVersion={live?.version ?? null}
      connectors={connectors}
      configuredProviders={providers}
      sources={sources}
      flows={flows}
      canEdit={can(current, "builder")}
      canComment={can(current, "reviewer")}
      initialUpdatedAt={flow.updatedAt}
    />
  );
}
