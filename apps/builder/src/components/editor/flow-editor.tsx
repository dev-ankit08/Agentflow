"use client";

import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateFlow, variableTypes, type FlowInput, type NodeDef, type NodeType } from "@agentflow/flow-schema";
import { Badge, Button, Input, Select, cn } from "@agentflow/ui";
import { Row } from "./fields";
import { useCollab } from "./collab";
import { Inspector } from "./inspector";
import type { FlowComment } from "./inspector-orchestration";
import type { FlowSummary, SourceSummary } from "./inspector-extra";
import {
  autoLayout,
  edgeToCanvas,
  fromCanvas,
  newNode,
  nodeMeta,
  paletteGroups,
  toCanvas,
  uniqueId,
  variableSuggestions,
  type ConnectorSummary,
  type FlowNode,
} from "./model";
import { NodeCard } from "./node-card";
import { TestConsole } from "./test-console";

type Props = {
  flowId: string;
  initial: FlowInput;
  liveVersion: number | null;
  connectors: ConnectorSummary[];
  configuredProviders: string[];
  sources: SourceSummary[];
  flows: FlowSummary[];
  canEdit: boolean;
  canComment: boolean;
  /** When the draft was last saved; used to detect someone else's newer save. */
  initialUpdatedAt: string;
};

type Snapshot = { nodes: FlowNode[]; edges: Edge[]; base: FlowInput };
const nodeTypes = { af: NodeCard };
const DRAG_TYPE = "application/agentflow-node";

export function FlowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({
  flowId,
  initial,
  liveVersion: initialLive,
  connectors,
  configuredProviders,
  canEdit,
  canComment,
  sources,
  flows,
  initialUpdatedAt,
}: Props) {
  const canvas = useMemo(() => toCanvas(initial), [initial]);
  const [nodes, setNodes] = useState<FlowNode[]>(canvas.nodes);
  const [edges, setEdges] = useState<Edge[]>(canvas.edges);
  const [base, setBase] = useState<FlowInput>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "error">("saved");
  const [showTest, setShowTest] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [liveVersion, setLiveVersion] = useState(initialLive);
  const [runStatus, setRunStatus] = useState<Record<string, "running" | "ok" | "error">>({});
  const baseUpdatedAt = useRef(initialUpdatedAt);
  const [conflict, setConflict] = useState(false);
  const [othersEditing, setOthersEditing] = useState<{ userId: string; name: string; nodeId: string | null }[]>([]);
  const [newerElsewhere, setNewerElsewhere] = useState(false);
  const [comments, setComments] = useState<FlowComment[]>([]);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastPush = useRef(0);
  const clipboard = useRef<NodeDef[]>([]);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const draft = useMemo(() => fromCanvas(base, nodes, edges), [base, nodes, edges]);
  const validation = useMemo(() => validateFlow(draft), [draft]);

  // Live co-editing: edits from others replace the canvas content, keeping this editor's selection.
  const collab = useCollab({
    flowId,
    draft,
    canEdit,
    onRemote: (remote) => {
      const next = toCanvas(remote);
      setBase(remote);
      setNodes((prev) => {
        const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
        return next.nodes.map((n) => ({ ...n, selected: selected.has(n.id) }));
      });
      setEdges(next.edges);
      // What the canvas will produce from this state, so it isn't mistaken for a local edit.
      return fromCanvas(remote, next.nodes, next.edges);
    },
  });
  const issuesByNode = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of validation.errors) if (e.nodeId) map.set(e.nodeId, [...(map.get(e.nodeId) ?? []), e.message]);
    return map;
  }, [validation]);

  // --- History -----------------------------------------------------------------
  const snapshot = useCallback((): Snapshot => ({ nodes, edges, base }), [nodes, edges, base]);
  const remember = useCallback(
    (coalesce = false) => {
      const now = Date.now();
      if (coalesce && now - lastPush.current < 800) return;
      lastPush.current = now;
      past.current = [...past.current.slice(-49), snapshot()];
      future.current = [];
    },
    [snapshot],
  );
  const restore = (s: Snapshot) => {
    setNodes(s.nodes);
    setEdges(s.edges);
    setBase(s.base);
    setSaveState("unsaved");
  };
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(snapshot());
    restore(prev);
  }, [snapshot]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(snapshot());
    restore(next);
  }, [snapshot]);

  // --- Saving --------------------------------------------------------------------
  const save = useCallback(
    async (force = false): Promise<boolean> => {
      if (!canEdit) return true;
      setSaveState("saving");
      const res = await fetch(`/api/v1/flows/${flowId}/draft`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, baseUpdatedAt: baseUpdatedAt.current, force }),
      }).catch(() => null);
      if (res?.status === 409) {
        setConflict(true);
        setSaveState("error");
        return false;
      }
      if (res?.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.updatedAt) baseUpdatedAt.current = body.updatedAt;
        setConflict(false);
        setNewerElsewhere(false);
      }
      setSaveState(res?.ok ? "saved" : "error");
      return Boolean(res?.ok);
    },
    [canEdit, draft, flowId],
  );

  // Presence: who else has this flow open, and whether they saved a newer draft.
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      const res = await fetch(`/api/v1/flows/${flowId}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selectedId ? { nodeId: selectedId } : {}),
      }).catch(() => null);
      const body = res?.ok ? await res.json().catch(() => null) : null;
      if (stopped || !body) return;
      setOthersEditing(body.others ?? []);
      if (body.updatedAt && new Date(body.updatedAt).getTime() > new Date(baseUpdatedAt.current).getTime())
        setNewerElsewhere(true);
    };
    void beat();
    const t = setInterval(() => void beat(), 10_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [flowId, selectedId]);

  // Node comments.
  const loadComments = useCallback(async () => {
    const res = await fetch(`/api/v1/flows/${flowId}/comments`).catch(() => null);
    if (res?.ok) setComments((await res.json()).comments ?? []);
  }, [flowId]);
  useEffect(() => void loadComments(), [loadComments]);
  const addComment = useCallback(
    async (nodeId: string, body: string) => {
      await fetch(`/api/v1/flows/${flowId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId, body }),
      });
      await loadComments();
    },
    [flowId, loadComments],
  );
  const resolveComment = useCallback(
    async (id: string, resolved: boolean) => {
      await fetch(`/api/v1/flows/${flowId}/comments/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
      await loadComments();
    },
    [flowId, loadComments],
  );

  useEffect(() => {
    // While live, the API saves the shared document; this editor doesn't autosave.
    if (saveState !== "unsaved" || conflict || collab.live) return;
    const t = setTimeout(() => void save(), 800);
    return () => clearTimeout(t);
  }, [saveState, save, conflict, collab.live]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveState === "unsaved" || saveState === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  const touch = () => setSaveState("unsaved");

  // --- Canvas changes --------------------------------------------------------------
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const structural = changes.some((c) => c.type === "remove");
      if (structural) remember();
      setNodes((ns) =>
        applyNodeChanges(canEdit ? changes : changes.filter((c) => c.type === "select" || c.type === "dimensions"), ns),
      );
      if (changes.some((c) => c.type === "remove" || (c.type === "position" && !c.dragging))) touch();
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (removed.length)
        setEdges((es) => es.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)));
    },
    [canEdit, remember],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!canEdit) return;
      if (changes.some((c) => c.type === "remove")) {
        remember();
        touch();
      }
      setEdges((es) => applyEdgeChanges(changes, es));
    },
    [canEdit, remember],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || c.source === c.target) return;
      remember();
      setEdges((es) => {
        const source = nodes.find((n) => n.id === c.source)?.data.node;
        // One connection per output: a new one replaces the old.
        const rest = es.filter(
          (e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)),
        );
        const id = uniqueId("e", new Set(es.map((e) => e.id)));
        const edge = edgeToCanvas(source ? [source] : [])({
          id,
          source: c.source,
          target: c.target,
          ...(c.sourceHandle ? { sourceHandle: c.sourceHandle } : {}),
        });
        return [...rest, edge];
      });
      touch();
    },
    [canEdit, nodes, remember],
  );

  const addNode = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      if (!canEdit) return;
      remember();
      const id = uniqueId(type === "mcp_tool" ? "tool" : type, new Set(nodes.map((n) => n.id)));
      const node = newNode(type, id, position, configuredProviders);
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { id, type: "af", position, data: { node }, selected: true },
      ]);
      setSelectedId(id);
      touch();
    },
    [canEdit, configuredProviders, nodes, remember],
  );

  const updateNode = useCallback(
    (next: NodeDef) => {
      remember(true);
      setNodes((ns) => ns.map((n) => (n.id === next.id ? { ...n, data: { ...n.data, node: next } } : n)));
      // Drop connections whose decision outcome no longer exists.
      if (next.type === "decision") {
        const handles = new Set([...next.config.outcomes.map((o) => o.id), next.config.defaultOutcome]);
        setEdges((es) => es.filter((e) => e.source !== next.id || (e.sourceHandle && handles.has(e.sourceHandle))));
      }
      touch();
    },
    [remember],
  );

  const renameNode = useCallback(
    (oldId: string, newId: string): string | null => {
      if (nodes.some((n) => n.id === newId)) return `Another node already uses the id "${newId}"`;
      remember();
      setNodes((ns) =>
        ns.map((n) =>
          n.id === oldId ? { ...n, id: newId, data: { ...n.data, node: { ...n.data.node, id: newId } } } : n,
        ),
      );
      setEdges((es) =>
        es.map((e) => ({
          ...e,
          source: e.source === oldId ? newId : e.source,
          target: e.target === oldId ? newId : e.target,
        })),
      );
      setSelectedId(newId);
      touch();
      return null;
    },
    [nodes, remember],
  );

  const deleteSelected = useCallback(() => {
    const target = nodes.find((n) => n.id === selectedId);
    if (!target || target.data.node.type === "start" || !canEdit) return;
    remember();
    setNodes((ns) => ns.filter((n) => n.id !== target.id));
    setEdges((es) => es.filter((e) => e.source !== target.id && e.target !== target.id));
    setSelectedId(null);
    touch();
  }, [canEdit, nodes, remember, selectedId]);

  // --- Keyboard: undo/redo, copy/paste -------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !canEdit) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else if (key === "c") {
        clipboard.current = nodes.filter((n) => n.selected && n.data.node.type !== "start").map((n) => n.data.node);
      } else if (key === "v" && clipboard.current.length) {
        e.preventDefault();
        remember();
        const taken = new Set(nodes.map((n) => n.id));
        const pasted = clipboard.current.map((n) => {
          const id = uniqueId(n.id, taken);
          taken.add(id);
          const position = { x: n.position.x + 40, y: n.position.y + 40 };
          return {
            id,
            type: "af" as const,
            position,
            selected: true,
            data: { node: { ...structuredClone(n), id, position } },
          };
        });
        setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...pasted]);
        touch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, nodes, redo, remember, undo]);

  // --- Publish ------------------------------------------------------------------------
  async function publish() {
    if (!validation.ok) {
      setShowIssues(true);
      return;
    }
    if (!(await save(collab.live))) return setNotice({ tone: "danger", text: "Could not save the draft." });
    const res = await fetch(`/api/v1/flows/${flowId}/publish`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      return setNotice({ tone: "danger", text: body.issues?.[0]?.message ?? body.error ?? "Publish failed" });
    setLiveVersion(body.version);
    setNotice({ tone: "success", text: `Published version ${body.version}. It is now live for the widget and API.` });
  }

  const renderedNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          status: runStatus[n.id],
          issues: issuesByNode.get(n.id)?.length,
          comments: comments.filter((c) => c.nodeId === n.id && !c.resolvedAt).length,
        },
      })),
    [nodes, runStatus, issuesByNode, comments],
  );
  const selected = nodes.find((n) => n.id === selectedId)?.data.node ?? null;
  const suggestions = useMemo(() => variableSuggestions(draft, selectedId ?? undefined), [draft, selectedId]);

  return (
    <div className="flex h-screen flex-col bg-bg">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <Link href="/flows" className="text-sm text-muted hover:text-text" aria-label="Back to flows">
          ←
        </Link>
        <input
          aria-label="Flow name"
          value={base.name}
          disabled={!canEdit}
          onChange={(e) => {
            remember(true);
            setBase((b) => ({ ...b, name: e.target.value }));
            touch();
          }}
          className="w-64 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-text hover:border-border focus:border-accent focus:outline-none"
        />
        <Badge tone={liveVersion ? "success" : "neutral"}>
          {liveVersion ? `Live v${liveVersion}` : "Not published"}
        </Badge>
        <span className="text-xs text-muted" aria-live="polite">
          {collab.live
            ? canEdit
              ? "● Live · saved automatically"
              : "● Live · view only"
            : canEdit
              ? {
                  saved: "Saved",
                  saving: "Saving…",
                  unsaved: "Unsaved changes",
                  error: conflict ? "Not saved — edit conflict" : "Save failed — retrying on next change",
                }[saveState]
              : "View only"}
        </span>
        {othersEditing.length > 0 && (
          <div className="flex items-center gap-1" aria-label="Also editing">
            {othersEditing.map((o) => (
              <span
                key={o.userId}
                title={`${o.name} is viewing${o.nodeId ? ` "${o.nodeId}"` : " this flow"}`}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-white"
              >
                {o.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
            <span className="text-[11px] text-muted">also here</span>
          </div>
        )}
        <div className="relative ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowIssues((s) => !s)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium",
              validation.ok ? "bg-success/15 text-success" : "bg-danger/15 text-danger",
            )}
          >
            {validation.ok
              ? "✓ Valid"
              : `${validation.errors.length} issue${validation.errors.length === 1 ? "" : "s"}`}
          </button>
          {showIssues && !validation.ok && (
            <div className="absolute right-0 top-10 z-20 max-h-80 w-96 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-lg">
              {validation.errors.map((e, i) => (
                <button
                  key={i}
                  type="button"
                  className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-text hover:bg-surface-2"
                  onClick={() => {
                    if (e.nodeId) {
                      setSelectedId(e.nodeId);
                      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === e.nodeId })));
                    }
                    setShowIssues(false);
                  }}
                >
                  <span className="text-danger">✕</span> {e.message}
                  {e.nodeId && <span className="text-muted"> · {e.nodeId}</span>}
                </button>
              ))}
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={undo} disabled={!canEdit} title="Undo (Ctrl+Z)">
            ↶
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={!canEdit} title="Redo (Ctrl+Y)">
            ↷
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canEdit}
            onClick={() => {
              remember();
              setNodes((ns) => autoLayout(ns, edges));
              touch();
              setTimeout(() => fitView({ padding: 0.2 }), 50);
            }}
          >
            Auto-layout
          </Button>
          <Button variant={showTest ? "primary" : "secondary"} size="sm" onClick={() => setShowTest((s) => !s)}>
            ▶ Test
          </Button>
          <Link
            href={`/flows/${flowId}/evals`}
            className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-2"
          >
            Evals
          </Link>
          <Link
            href={`/flows/${flowId}/deploy`}
            className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-2"
          >
            Deploy
          </Link>
          {canEdit && (
            <Button size="sm" onClick={publish}>
              Publish
            </Button>
          )}
        </div>
      </header>
      {(conflict || newerElsewhere) && canEdit && !collab.live && (
        <div role="alert" className="flex items-center gap-3 bg-warning/10 px-4 py-2 text-xs text-warning">
          <span className="flex-1">
            {conflict
              ? "Someone else saved this flow while you were editing. Your latest changes are not saved."
              : "Someone else saved a newer version of this flow."}
          </span>
          <button type="button" className="font-medium underline" onClick={() => window.location.reload()}>
            Reload their version
          </button>
          {conflict && (
            <button type="button" className="font-medium underline" onClick={() => void save(true)}>
              Keep mine (overwrite)
            </button>
          )}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className={cn(
            "flex items-center justify-between px-4 py-2 text-xs",
            notice.tone === "success" ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
          )}
        >
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <aside
          aria-label="Node palette"
          className="w-52 shrink-0 overflow-y-auto border-r border-border bg-surface p-3"
        >
          {paletteGroups.map((g) => (
            <div key={g.title} className="mb-4">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{g.title}</p>
              {g.types.map((type) => {
                const meta = nodeMeta[type];
                return (
                  <button
                    key={type}
                    type="button"
                    draggable={canEdit}
                    disabled={!canEdit}
                    title={`${meta.hint} — drag onto the canvas or click to add`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, type);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() =>
                      addNode(type, screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 - 100 }))
                    }
                    className="mb-1 flex w-full cursor-grab items-center gap-2 rounded-lg border border-border bg-surface px-2 py-2 text-left text-xs text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span
                      className="flex h-6 w-6 items-center justify-center rounded-md text-white"
                      style={{ background: meta.color }}
                      aria-hidden
                    >
                      {meta.icon}
                    </span>
                    {meta.label}
                  </button>
                );
              })}
            </div>
          ))}
          <p className="text-[10px] leading-relaxed text-muted">
            Drag nodes onto the canvas, then connect the dots. Ctrl+C / Ctrl+V copies nodes; Delete removes them.
          </p>
        </aside>

        {/* Canvas */}
        <div
          className="relative min-w-0 flex-1"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DRAG_TYPE)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(e) => {
            const type = e.dataTransfer.getData(DRAG_TYPE) as NodeType;
            if (!type) return;
            e.preventDefault();
            addNode(type, screenToFlowPosition({ x: e.clientX - 100, y: e.clientY - 30 }));
          }}
        >
          <ReactFlow
            nodes={renderedNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={() => remember()}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel.length === 1 ? sel[0]!.id : null)}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            deleteKeyCode={canEdit ? ["Delete", "Backspace"] : null}
            defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              className="!bg-surface"
              nodeColor={(n) => nodeMeta[(n as FlowNode).data.node.type].color}
            />
          </ReactFlow>
        </div>

        {/* Properties */}
        <aside aria-label="Properties" className="w-[360px] shrink-0 overflow-y-auto border-l border-border bg-surface">
          {selected ? (
            <Inspector
              key={selected.id}
              node={selected}
              onChange={updateNode}
              onRename={renameNode}
              onDelete={deleteSelected}
              suggestions={suggestions}
              connectors={connectors}
              configuredProviders={configuredProviders}
              issues={issuesByNode.get(selected.id) ?? []}
              readOnly={!canEdit}
              sources={sources}
              flows={flows}
              currentFlowId={flowId}
              triggers={base.triggers}
              onTriggersChange={(triggers) => {
                remember(true);
                setBase((b) => ({ ...b, triggers }));
                touch();
              }}
              comments={comments}
              onAddComment={addComment}
              onResolveComment={resolveComment}
              canComment={canComment}
            />
          ) : (
            <FlowSettings
              base={base}
              readOnly={!canEdit}
              warnings={validation.warnings.map((w) => w.message)}
              globalErrors={validation.errors.filter((e) => !e.nodeId).map((e) => e.message)}
              onChange={(next) => {
                remember(true);
                setBase(next);
                touch();
              }}
            />
          )}
        </aside>
      </div>

      {showTest && (
        <TestConsole
          flowId={flowId}
          prepare={async () => validation.ok && (await save(collab.live))}
          onStatus={setRunStatus}
          onClose={() => {
            setShowTest(false);
            setRunStatus({});
          }}
        />
      )}
    </div>
  );
}

/** Shown when no node is selected: flow-level variables and limits. */
function FlowSettings({
  base,
  onChange,
  readOnly,
  warnings,
  globalErrors,
}: {
  base: FlowInput;
  onChange: (f: FlowInput) => void;
  readOnly: boolean;
  warnings: string[];
  globalErrors: string[];
}) {
  const variables = base.variables ?? [];
  const settings = { maxSteps: 25, maxCostUsd: 0.5, ...base.settings };
  const setVars = (next: typeof variables) => onChange({ ...base, variables: next });
  return (
    <div className="space-y-5 p-4">
      <div>
        <p className="text-sm font-semibold text-text">Flow settings</p>
        <p className="text-xs text-muted">Select a node to edit it. These settings apply to the whole flow.</p>
      </div>
      {[
        ...globalErrors.map((m) => ({ m, tone: "text-danger" })),
        ...warnings.map((m) => ({ m, tone: "text-warning" })),
      ].map((x, i) => (
        <p key={i} className={cn("text-xs", x.tone)}>
          {x.m}
        </p>
      ))}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-text">Variables</p>
        <p className="text-[11px] text-muted">
          Values kept across the conversation. Set them with Assignment nodes; read them as {"{{name}}"}.
        </p>
        {variables.map((v, i) => (
          <div key={i} className="grid grid-cols-[1fr_90px_auto] gap-1">
            <Input
              value={v.name}
              aria-label="Variable name"
              disabled={readOnly}
              className="h-8 font-mono text-xs"
              onChange={(e) =>
                setVars(
                  variables.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") } : x)),
                )
              }
            />
            <Select
              value={v.type}
              aria-label="Variable type"
              disabled={readOnly}
              className="h-8 text-xs"
              onChange={(e) =>
                setVars(variables.map((x, j) => (j === i ? { ...x, type: e.target.value as typeof v.type } : x)))
              }
            >
              {variableTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              disabled={readOnly}
              aria-label="Remove variable"
              onClick={() => setVars(variables.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </div>
        ))}
        {!readOnly && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setVars([...variables, { name: `var${variables.length + 1}`, type: "text" }])}
          >
            + Add variable
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Row label="Max steps per message">
          <Input
            type="number"
            min={1}
            max={500}
            disabled={readOnly}
            className="h-8 text-xs"
            value={settings.maxSteps}
            onChange={(e) => onChange({ ...base, settings: { ...settings, maxSteps: Number(e.target.value) || 25 } })}
          />
        </Row>
        <Row label="Max cost per run ($)">
          <Input
            type="number"
            min={0.01}
            step="0.05"
            disabled={readOnly}
            className="h-8 text-xs"
            value={settings.maxCostUsd}
            onChange={(e) =>
              onChange({ ...base, settings: { ...settings, maxCostUsd: Number(e.target.value) || 0.5 } })
            }
          />
        </Row>
      </div>
    </div>
  );
}
