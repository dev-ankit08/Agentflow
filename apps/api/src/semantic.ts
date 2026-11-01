import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { chunks, documents, workspaces, type Db } from "@agentflow/db";
import type { LLMGateway, ModelRef } from "@agentflow/llm-gateway";
import type { KnowledgeChunk } from "@agentflow/runtime";
import { orQuery } from "./automation";

/**
 * Semantic knowledge search (H7). Chunks get a vector from the workspace's embedding model; searches blend
 * full-text and vector rankings with reciprocal rank fusion. Vectors are compared in the API process, which is
 * fine for prototype-sized knowledge bases; pgvector can replace this behind the same functions later.
 */

const modelKey = (m: ModelRef) => `${m.provider}/${m.name}`;

export async function embeddingModelOf(db: Db, workspaceId: string): Promise<ModelRef | null> {
  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return ws?.settings.embedding ?? null;
}

/** Embeds chunks that have no vector yet, or one from a different model. Returns how many were done and remain. */
export async function indexKnowledge(db: Db, gateway: LLMGateway, workspaceId: string, limit = 256) {
  const model = await embeddingModelOf(db, workspaceId);
  if (!model) return { indexed: 0, remaining: 0, model: null };
  const key = modelKey(model);
  const stale = and(
    eq(chunks.workspaceId, workspaceId),
    or(isNull(chunks.embeddingModel), and(ne(chunks.embeddingModel, key), ne(chunks.embeddingModel, `${key}#failed`))),
  );
  const pending = await db.select({ id: chunks.id, content: chunks.content }).from(chunks).where(stale).limit(limit);
  if (pending.length) {
    let vectors: (number[] | null)[];
    try {
      vectors = await gateway.embed(
        model,
        pending.map((c) => c.content),
      );
    } catch {
      // One bad passage (e.g. too long) shouldn't stall the whole batch: embed one by one and mark failures,
      // which are skipped until the embedding model changes.
      vectors = [];
      for (const c of pending) vectors.push((await gateway.embed(model, [c.content]).catch(() => [null]))[0] ?? null);
    }
    for (let i = 0; i < pending.length; i++) {
      const v = vectors[i];
      await db
        .update(chunks)
        .set(v ? { embedding: v, embeddingModel: key } : { embedding: null, embeddingModel: `${key}#failed` })
        .where(eq(chunks.id, pending[i]!.id));
    }
  }
  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chunks)
    .where(stale);
  return { indexed: pending.length, remaining: left?.n ?? 0, model: key };
}

/** Indexing status for the Settings page. */
export async function indexStatus(db: Db, workspaceId: string) {
  const model = await embeddingModelOf(db, workspaceId);
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      indexed: model
        ? sql<number>`count(*) filter (where ${chunks.embeddingModel} = ${modelKey(model)})::int`
        : sql<number>`0`,
    })
    .from(chunks)
    .where(eq(chunks.workspaceId, workspaceId));
  return { model, total: row?.total ?? 0, indexed: Number(row?.indexed ?? 0) };
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * Hybrid retrieval. Full-text query words are OR-ed and ranked by cover density; when an embedding model is set,
 * the query is also embedded and compared with every indexed chunk. Both rankings are fused (RRF, k = 60).
 * If embedding fails, results fall back to full-text only.
 */
export async function searchKnowledge(
  db: Db,
  workspaceId: string,
  query: string,
  opts: { sources: string[]; topK: number },
  gateway?: LLMGateway,
): Promise<KnowledgeChunk[]> {
  const candidates = Math.max(20, opts.topK * 5);
  const scope = and(
    eq(chunks.workspaceId, workspaceId),
    opts.sources.length ? inArray(documents.sourceId, opts.sources) : undefined,
  );
  const tsq = orQuery(query);
  const textHits = await db
    .select({ id: chunks.id, text: chunks.content, title: documents.title, uri: documents.uri })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(and(scope, sql`${chunks.tsv} @@ ${tsq}`))
    .orderBy(sql`ts_rank_cd(${chunks.tsv}, ${tsq}) desc`)
    .limit(candidates);

  let vectorHits: typeof textHits = [];
  const model = gateway ? await embeddingModelOf(db, workspaceId) : null;
  if (gateway && model) {
    try {
      const [q] = await gateway.embed(model, [query]);
      const rows = await db
        .select({
          id: chunks.id,
          text: chunks.content,
          title: documents.title,
          uri: documents.uri,
          embedding: chunks.embedding,
        })
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.documentId))
        .where(and(scope, eq(chunks.embeddingModel, modelKey(model))))
        .limit(5000);
      vectorHits = rows
        .map((r) => ({ row: r, sim: cosine(q!, r.embedding ?? []) }))
        .filter((x) => x.sim > 0.1)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, candidates)
        .map(({ row: { embedding: _e, ...r } }) => r);
    } catch {
      vectorHits = [];
    }
  }

  const fused = new Map<string, { hit: (typeof textHits)[number]; score: number }>();
  for (const list of [textHits, vectorHits]) {
    list.forEach((hit, rank) => {
      const entry = fused.get(hit.id) ?? { hit, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      fused.set(hit.id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK)
    .map(({ hit: { id: _id, ...h }, score }) => ({ ...h, score: Math.round(score * 10_000) / 10_000 }));
}
