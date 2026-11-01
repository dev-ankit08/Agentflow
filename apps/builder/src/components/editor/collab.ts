"use client";

import { useEffect, useRef, useState } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { FlowInput } from "@agentflow/flow-schema";

/** Marks changes made by this editor, so they aren't applied back to the canvas. */
const LOCAL = Symbol("local");

/** Same layout as the API's document: nodes and edges keyed by id, flow-level fields in "meta". */
function docToDraft(doc: Y.Doc): FlowInput {
  const nodes = [...doc.getMap<FlowInput["nodes"][number]>("nodes").values()];
  nodes.sort((a, b) => (a.type === "start" ? -1 : b.type === "start" ? 1 : a.id.localeCompare(b.id)));
  const edges = [...doc.getMap<FlowInput["edges"][number]>("edges").values()].sort((a, b) => a.id.localeCompare(b.id));
  return { ...(Object.fromEntries(doc.getMap("meta").entries()) as Omit<FlowInput, "nodes" | "edges">), nodes, edges };
}

/**
 * Writes only what this editor changed since `last` (the state it last pushed or received), so a peer that hasn't
 * seen someone else's edit yet can't overwrite it with its stale copy.
 */
function pushChanges(doc: Y.Doc, draft: FlowInput, last: FlowInput) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  doc.transact(() => {
    for (const name of ["nodes", "edges"] as const) {
      const map = doc.getMap<unknown>(name);
      const before = new Map<string, unknown>(last[name].map((x) => [x.id, x]));
      const now = new Map<string, unknown>(draft[name].map((x) => [x.id, x]));
      for (const [id, item] of now) if (!same(before.get(id), item)) map.set(id, item);
      for (const id of before.keys()) if (!now.has(id)) map.delete(id);
    }
    const meta = doc.getMap<unknown>("meta");
    const { nodes: _n, edges: _e, ...rest } = draft;
    const { nodes: _ln, edges: _le, ...lastRest } = last;
    for (const [k, v] of Object.entries(rest)) if (!same((lastRest as Record<string, unknown>)[k], v)) meta.set(k, v);
    for (const k of Object.keys(lastRest)) if (!(k in rest)) meta.delete(k);
  }, LOCAL);
}

export type CollabStatus = "connecting" | "live" | "offline";

/**
 * Live co-editing (H10): keeps the editor's draft in a shared Yjs document on the API. Local edits are pushed
 * (throttled); edits from others arrive through `onRemote`. While live, the API saves the draft, so the editor's
 * own autosave and conflict checks stand aside. Falls back to "offline" (normal saving) if the socket is down.
 */
export function useCollab({
  flowId,
  draft,
  canEdit,
  onRemote,
}: {
  flowId: string;
  draft: FlowInput;
  canEdit: boolean;
  /** Applies a remote state to the canvas and returns the draft the canvas now produces. */
  onRemote: (draft: FlowInput) => FlowInput;
}) {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const docRef = useRef<Y.Doc | null>(null);
  const synced = useRef(false);
  const last = useRef<FlowInput | null>(null);
  // The latest local draft, so pending edits can be pushed before a remote change replaces the canvas.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  useEffect(() => {
    let provider: WebsocketProvider | null = null;
    let stopped = false;
    const doc = new Y.Doc();
    docRef.current = doc;
    const freshToken = async () => {
      const res = await fetch("/api/collab-token").catch(() => null);
      return res?.ok ? ((await res.json()) as { token: string; url: string }) : null;
    };
    void (async () => {
      // Retry the first token fetch for a while instead of staying offline for the whole session.
      let auth = await freshToken();
      for (let i = 0; !auth && !stopped && i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        auth = await freshToken();
      }
      if (!auth || stopped) return setStatus("offline");
      provider = new WebsocketProvider(auth.url, flowId, doc, { params: { token: auth.token }, disableBc: true });
      provider.on("status", async ({ status: s }: { status: string }) => {
        if (s === "connected") return;
        synced.current = false;
        setStatus("offline");
        // Tokens expire after an hour; use a fresh one for the next reconnect attempt.
        const next = await freshToken();
        if (next && provider) provider.params = { token: next.token };
      });
      provider.on("sync", (isSynced: boolean) => {
        if (!isSynced) return;
        // On a reconnect, edits made while offline are pushed first instead of being overwritten.
        if (last.current && canEditRef.current) pushChanges(doc, draftRef.current, last.current);
        synced.current = true;
        setStatus("live");
        last.current = onRemoteRef.current(docToDraft(doc));
      });
    })();
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL || !synced.current) return;
      // Push this editor's not-yet-sent changes first, so the remote update doesn't wipe them.
      if (last.current && canEditRef.current) pushChanges(doc, draftRef.current, last.current);
      last.current = onRemoteRef.current(docToDraft(doc));
    });
    return () => {
      stopped = true;
      provider?.destroy();
      doc.destroy();
      docRef.current = null;
    };
  }, [flowId]);

  // Push local edits, throttled so dragging a node doesn't flood the socket.
  useEffect(() => {
    if (status !== "live" || !canEdit || !docRef.current) return;
    const t = setTimeout(() => {
      if (!docRef.current || !synced.current || !last.current) return;
      pushChanges(docRef.current, draft, last.current);
      last.current = draft;
    }, 120);
    return () => clearTimeout(t);
  }, [draft, status, canEdit]);

  return { status, live: status === "live" };
}
