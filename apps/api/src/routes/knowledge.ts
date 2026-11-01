import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chunks, documents, knowledgeSources, type Db } from "@agentflow/db";
import { HttpError, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { assertPublicUrl } from "../services";
import { searchKnowledge } from "../workspace-services";

const MAX_CHARS = 500_000;

/** Splits text into ~800-character passages on paragraph/sentence boundaries, with a little overlap. */
export function chunkText(text: string, size = 800, overlap = 120): string[] {
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = current.length > overlap ? current.slice(-overlap) : "";
  };
  for (const p of paragraphs) {
    const pieces = p.length > size ? (p.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [p]) : [p];
    for (const piece of pieces) {
      if (current.length + piece.length > size && current.length > overlap) flush();
      current += (current ? " " : "") + piece;
    }
    current += "\n";
  }
  flush();
  return out.filter((c, i, all) => c.length > 20 || all.length === 1);
}

/** Readable text and title from an HTML page (scripts, styles and navigation removed). */
export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(head|script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|section|article|br|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n");
  return { title, text: text.trim() };
}

async function ingest(
  db: Db,
  workspaceId: string,
  sourceId: string,
  doc: { title: string; uri: string | null; text: string },
) {
  const contentHash = createHash("sha256").update(doc.text).digest("hex");
  const [existing] = await db
    .select({ id: documents.id, contentHash: documents.contentHash })
    .from(documents)
    .where(eq(documents.sourceId, sourceId));
  if (existing?.contentHash === contentHash) return { changed: false, chunks: 0 };
  const passages = chunkText(doc.text);
  if (passages.length === 0) throw new HttpError(422, "No readable text found");
  await db.transaction(async (tx) => {
    if (existing) await tx.delete(documents).where(eq(documents.id, existing.id));
    const [created] = await tx
      .insert(documents)
      .values({ sourceId, title: doc.title, uri: doc.uri, contentHash })
      .returning({ id: documents.id });
    await tx
      .insert(chunks)
      .values(passages.map((content, position) => ({ documentId: created!.id, workspaceId, position, content })));
  });
  return { changed: true, chunks: passages.length };
}

async function fetchPage(url: string, allowPrivate: boolean) {
  if (!allowPrivate) await assertPublicUrl(url).catch((e: Error) => Promise.reject(new HttpError(400, e.message)));
  const res = await fetch(url, {
    headers: { "user-agent": "AgentFlowBot/0.1" },
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => Promise.reject(new HttpError(422, `Could not fetch ${url}: ${e.message}`)));
  if (!res.ok) throw new HttpError(422, `Could not fetch ${url} (HTTP ${res.status})`);
  const body = (await res.text()).slice(0, MAX_CHARS * 2);
  const isHtml = (res.headers.get("content-type") ?? "").includes("html") || /<html[\s>]/i.test(body);
  return isHtml ? htmlToText(body) : { title: "", text: body };
}

const AddSource = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    name: z.string().trim().min(1).max(120),
    content: z.string().min(1).max(MAX_CHARS),
  }),
  z.object({ type: z.literal("url"), name: z.string().trim().max(120).optional(), uri: z.url() }),
]);

/** Knowledge sources agents can answer from (H7). */
export async function knowledgeRoutes(app: FastifyInstance, { db, auth, config }: Deps) {
  const find = async (workspaceId: string, id: string) => {
    const [row] = await db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.id, id), eq(knowledgeSources.workspaceId, workspaceId)));
    if (!row) throw new HttpError(404, "Knowledge source not found");
    return row;
  };

  app.get("/knowledge", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const ws = currentWorkspace(req);
    const rows = await db
      .select({
        id: knowledgeSources.id,
        name: knowledgeSources.name,
        type: knowledgeSources.type,
        uri: knowledgeSources.uri,
        status: knowledgeSources.status,
        error: knowledgeSources.error,
        lastSyncedAt: knowledgeSources.lastSyncedAt,
        chunks: sql<number>`count(${chunks.id})::int`,
      })
      .from(knowledgeSources)
      .leftJoin(documents, eq(documents.sourceId, knowledgeSources.id))
      .leftJoin(chunks, eq(chunks.documentId, documents.id))
      .where(eq(knowledgeSources.workspaceId, ws.id))
      .groupBy(knowledgeSources.id)
      .orderBy(desc(knowledgeSources.createdAt));
    return { sources: rows };
  });

  app.post("/knowledge", { preHandler: auth.requireWorkspace("builder") }, async (req, reply) => {
    const body = AddSource.parse(req.body);
    const ws = currentWorkspace(req);
    const page = body.type === "url" ? await fetchPage(body.uri, config.allowPrivateHttp) : null;
    const name = body.type === "text" ? body.name : body.name || page!.title || body.uri;
    const [source] = await db
      .insert(knowledgeSources)
      .values({ workspaceId: ws.id, name, type: body.type, uri: body.type === "url" ? body.uri : null })
      .returning();
    try {
      const result = await ingest(db, ws.id, source!.id, {
        title: name,
        uri: body.type === "url" ? body.uri : null,
        text: body.type === "text" ? body.content : page!.text,
      });
      await db.update(knowledgeSources).set({ lastSyncedAt: new Date() }).where(eq(knowledgeSources.id, source!.id));
      return reply.code(201).send({ id: source!.id, name, chunks: result.chunks });
    } catch (error) {
      await db.delete(knowledgeSources).where(eq(knowledgeSources.id, source!.id));
      throw error;
    }
  });

  /** Re-fetches a web page source; unchanged content is skipped. */
  app.post<{ Params: { id: string } }>(
    "/knowledge/:id/sync",
    { preHandler: auth.requireWorkspace("builder") },
    async (req) => {
      const ws = currentWorkspace(req);
      const source = await find(ws.id, req.params.id);
      if (source.type !== "url" || !source.uri) throw new HttpError(400, "Only web page sources can be re-synced");
      try {
        const page = await fetchPage(source.uri, config.allowPrivateHttp);
        const result = await ingest(db, ws.id, source.id, { title: source.name, uri: source.uri, text: page.text });
        await db
          .update(knowledgeSources)
          .set({ status: "ready", error: null, lastSyncedAt: new Date() })
          .where(eq(knowledgeSources.id, source.id));
        return result;
      } catch (error) {
        await db
          .update(knowledgeSources)
          .set({ status: "error", error: (error as Error).message })
          .where(eq(knowledgeSources.id, source.id));
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/knowledge/:id",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await find(ws.id, req.params.id);
      await db
        .delete(knowledgeSources)
        .where(and(eq(knowledgeSources.id, req.params.id), eq(knowledgeSources.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );

  app.post("/knowledge/search", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const { query, topK } = z
      .object({ query: z.string().trim().min(1).max(500), topK: z.number().int().min(1).max(10).default(4) })
      .parse(req.body);
    return { results: await searchKnowledge(db, currentWorkspace(req).id, query, { sources: [], topK }) };
  });
}
