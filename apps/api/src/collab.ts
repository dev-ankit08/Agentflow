import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { customRoles, flows, memberships, type Db } from "@agentflow/db";
import type { FlowInput } from "@agentflow/flow-schema";
import { canEditFlows } from "./permissions";

/** Collaboration tokens are minted by the builder for one user, separately from the 5-minute API tokens. */
export const COLLAB_AUDIENCE = "agentflow-collab";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SAVE_DELAY_MS = 800;

/**
 * The shared flow document: nodes and edges keyed by id (each value is the node/edge JSON), plus flow-level
 * fields in "meta". Edits replace whole nodes, which is fine-grained enough for a canvas.
 */
export function draftToDoc(doc: Y.Doc, draft: FlowInput) {
  doc.transact(() => {
    const nodes = doc.getMap<unknown>("nodes");
    const edges = doc.getMap<unknown>("edges");
    const meta = doc.getMap<unknown>("meta");
    for (const n of draft.nodes) nodes.set(n.id, n);
    for (const e of draft.edges) edges.set(e.id, e);
    const { nodes: _n, edges: _e, ...rest } = draft;
    for (const [k, v] of Object.entries(rest)) meta.set(k, v);
  });
}

export function docToDraft(doc: Y.Doc): FlowInput {
  const nodes = [...doc.getMap<FlowInput["nodes"][number]>("nodes").values()];
  // Keep the Start node first, the rest in a stable order.
  nodes.sort((a, b) => (a.type === "start" ? -1 : b.type === "start" ? 1 : a.id.localeCompare(b.id)));
  const edges = [...doc.getMap<FlowInput["edges"][number]>("edges").values()].sort((a, b) => a.id.localeCompare(b.id));
  return { ...(Object.fromEntries(doc.getMap("meta").entries()) as Omit<FlowInput, "nodes" | "edges">), nodes, edges };
}

type Conn = { socket: WebSocket; userId: string; readonly: boolean; clientIds: Set<number> };

/** Open documents by flow id, so other routes can push changes into a live session. */
const liveRooms = new Map<string, Room>();

/**
 * A draft saved through the REST API while editors are live is merged into the shared document, so the next
 * live save doesn't overwrite it and every open editor sees it.
 */
export function applyDraftToLiveRoom(flowId: string, draft: FlowInput) {
  const room = liveRooms.get(flowId);
  if (!room) return false;
  room.doc.transact(() => {
    for (const name of ["nodes", "edges"] as const) {
      const map = room.doc.getMap<unknown>(name);
      const ids = new Set(draft[name].map((x) => x.id));
      for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
      for (const item of draft[name])
        if (JSON.stringify(map.get(item.id)) !== JSON.stringify(item)) map.set(item.id, item);
    }
    const meta = room.doc.getMap<unknown>("meta");
    const { nodes: _n, edges: _e, ...rest } = draft;
    for (const key of [...meta.keys()]) if (!(key in rest)) meta.delete(key);
    for (const [k, v] of Object.entries(rest)) if (JSON.stringify(meta.get(k)) !== JSON.stringify(v)) meta.set(k, v);
  }, "rest");
  return true;
}
type Room = {
  flowId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<Conn>;
  saveTimer: NodeJS.Timeout | null;
  recheck?: NodeJS.Timeout;
  save: () => Promise<void>;
};

/** Live co-editing (H10): one Yjs document per flow, shared over the y-websocket protocol. */
export async function collabRoutes(app: FastifyInstance, opts: { db: Db; jwtSecret: string }) {
  const { db } = opts;
  const key = new TextEncoder().encode(opts.jwtSecret);
  const rooms = new Map<string, Promise<Room>>();

  const send = (conn: Conn, data: Uint8Array) => {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(data);
  };

  async function openRoom(flowId: string): Promise<Room> {
    const [flow] = await db.select({ draft: flows.draftJson }).from(flows).where(eq(flows.id, flowId));
    const doc = new Y.Doc();
    draftToDoc(doc, flow!.draft);
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const room: Room = {
      flowId,
      doc,
      awareness,
      conns: new Set(),
      saveTimer: null,
      async save() {
        if (room.saveTimer) clearTimeout(room.saveTimer);
        room.saveTimer = null;
        const draft = docToDraft(doc);
        const name = typeof draft.name === "string" && draft.name.trim() ? draft.name.trim() : undefined;
        await db
          .update(flows)
          .set({ draftJson: { ...draft, id: flowId }, ...(name && { name }), updatedAt: new Date() })
          .where(eq(flows.id, flowId));
      },
    };
    doc.on("update", (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const c of room.conns) send(c, message);
      if (room.saveTimer) clearTimeout(room.saveTimer);
      room.saveTimer = setTimeout(
        () => void room.save().catch((err) => app.log.error({ err }, "collab save failed")),
        SAVE_DELAY_MS,
      );
    });
    awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        const conn = origin as Conn | null;
        if (conn?.clientIds) {
          for (const id of added) conn.clientIds.add(id);
          for (const id of removed) conn.clientIds.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
        const message = encoding.toUint8Array(encoder);
        for (const c of room.conns) send(c, message);
      },
    );
    liveRooms.set(flowId, room);
    // Access is re-checked while connected: removed members are disconnected, downgraded ones become read-only.
    room.recheck = setInterval(() => void recheckAccess(room).catch(() => {}), 30_000);
    room.recheck.unref();
    return room;
  }

  async function memberAccess(flowId: string, userId: string) {
    const [member] = await db
      .select({
        role: memberships.role,
        customRoleId: memberships.customRoleId,
        customPermissions: customRoles.permissions,
      })
      .from(flows)
      .innerJoin(memberships, and(eq(memberships.workspaceId, flows.workspaceId), eq(memberships.userId, userId)))
      .leftJoin(customRoles, eq(customRoles.id, memberships.customRoleId))
      .where(eq(flows.id, flowId));
    return member ? { canEdit: canEditFlows(member) } : null;
  }

  async function recheckAccess(room: Room) {
    for (const conn of room.conns) {
      const access = await memberAccess(room.flowId, conn.userId);
      if (!access) conn.socket.close(4403, "Access removed");
      else conn.readonly = !access.canEdit;
    }
  }

  const roomFor = (flowId: string) => {
    let room = rooms.get(flowId);
    if (!room) {
      room = openRoom(flowId);
      rooms.set(flowId, room);
    }
    return room;
  };

  async function leave(room: Room, conn: Conn) {
    room.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clientIds], null);
    if (room.conns.size === 0) {
      // Last one out: write any pending edits and forget the document (the database copy is the source of truth).
      if (room.saveTimer) await room.save().catch((err) => app.log.error({ err }, "collab save failed"));
      rooms.delete(room.flowId);
      liveRooms.delete(room.flowId);
      if (room.recheck) clearInterval(room.recheck);
      room.doc.destroy();
    }
  }

  app.get<{ Params: { flowId: string }; Querystring: { token?: string } }>(
    "/collab/:flowId",
    { websocket: true },
    async (socket, req) => {
      // The client starts its handshake as soon as the socket opens, so queue messages until it has joined.
      const queued: Buffer[] = [];
      let onMessage: ((data: Buffer) => void) | null = null;
      socket.on("message", (data: Buffer) => (onMessage ? onMessage(data) : queued.push(data)));
      let closedEarly = false;
      socket.on("close", () => (closedEarly = true));

      // Authenticate before joining: a valid collab token, and membership of the flow's workspace.
      let userId: string | undefined;
      try {
        const { payload } = await jwtVerify(req.query.token ?? "", key, {
          issuer: "agentflow-builder",
          audience: COLLAB_AUDIENCE,
        });
        userId = payload.sub;
      } catch {
        return socket.close(4401, "Invalid or expired collaboration token");
      }
      const member = await memberAccess(req.params.flowId, userId ?? "");
      if (!member) return socket.close(4404, "Flow not found");

      const room = await roomFor(req.params.flowId);
      if (closedEarly) return;
      const conn: Conn = { socket, userId: userId!, readonly: !member.canEdit, clientIds: new Set() };
      room.conns.add(conn);

      onMessage = (data: Buffer) => {
        try {
          const decoder = decoding.createDecoder(new Uint8Array(data));
          const type = decoding.readVarUint(decoder);
          if (type === MESSAGE_SYNC) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            if (conn.readonly) {
              // Read-only members may ask for the document but their edits are ignored.
              if (decoding.readVarUint(decoder) === syncProtocol.messageYjsSyncStep1) {
                syncProtocol.readSyncStep1(decoder, encoder, room.doc);
              }
            } else {
              syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
            }
            if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
          } else if (type === MESSAGE_AWARENESS) {
            awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
          }
        } catch (err) {
          app.log.warn({ err }, "bad collab message");
        }
      };
      socket.on("close", () => void leave(room, conn));

      // Start the handshake: our state vector, and who is already here.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, room.doc);
      send(conn, encoding.toUint8Array(encoder));
      const states = room.awareness.getStates();
      if (states.size > 0) {
        const aw = encoding.createEncoder();
        encoding.writeVarUint(aw, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
        send(conn, encoding.toUint8Array(aw));
      }
      for (const data of queued.splice(0)) onMessage(data);
    },
  );

  app.addHook("onClose", async () => {
    for (const pending of rooms.values()) {
      const room = await pending;
      if (room.saveTimer) await room.save().catch(() => {});
    }
  });
}
