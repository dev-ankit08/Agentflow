import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { responseCache, workspaces, type Db } from "@agentflow/db";
import type { LLMGateway } from "@agentflow/llm-gateway";
import type { RuntimeServices } from "@agentflow/runtime";
import { embeddingModelOf } from "./semantic";

/** How close a reworded question must be (cosine similarity) to reuse an answer. */
const SIMILARITY = 0.95;

const identifiers = (s: string) =>
  [...new Set(s.match(/[\w.+-]+@[\w-]+\.[\w.]+|\d[\d.,/-]*\d|\d/g) ?? [])].sort().join(" ");
const sameIdentifiers = (a: string, b: string) => identifiers(a) === identifiers(b);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

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
 * Response cache for a workspace (H11). Off unless `settings.cache.enabled`. Answers are keyed by flow, agent node,
 * model and the exact context the agent saw (rendered system prompt, earlier turns), so personal data in a prompt
 * keeps answers apart. The question matches exactly after normalising case and spaces, or by embedding similarity
 * when `similar` is on and the workspace has an embedding model.
 */
export function cacheService(db: Db, gateway: LLMGateway, workspaceId: string): NonNullable<RuntimeServices["cache"]> {
  const settings = async () => {
    const [ws] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!ws?.settings.cache?.enabled) return null;
    return { ...ws.settings.cache, zeroRetention: Boolean(ws.settings.retention?.zeroRetention) };
  };
  const embed = async (text: string) => {
    const model = await embeddingModelOf(db, workspaceId);
    if (!model) return null;
    const [v] = await gateway.embed(model, [text]).catch(() => [undefined]);
    return v ?? null;
  };
  const keyOf = (q: Parameters<NonNullable<RuntimeServices["cache"]>["lookup"]>[0]) => ({
    scope: and(
      eq(responseCache.workspaceId, workspaceId),
      eq(responseCache.flowId, q.flowId),
      eq(responseCache.nodeId, q.nodeId),
      eq(responseCache.contextHash, sha(JSON.stringify([q.model, q.context]))),
      gt(responseCache.expiresAt, new Date()),
    ),
    contextHash: sha(JSON.stringify([q.model, q.context])),
    input: normalise(q.input),
  });

  return {
    async lookup(q) {
      const cfg = await settings();
      if (!cfg) return null;
      const { scope, input } = keyOf(q);
      let [hit] = await db
        .select()
        .from(responseCache)
        .where(and(scope, eq(responseCache.inputHash, sha(input))));
      if (!hit && cfg.similar) {
        const vector = await embed(input);
        if (vector) {
          const candidates = await db
            .select()
            .from(responseCache)
            .where(and(scope, isNotNull(responseCache.embedding)))
            .limit(500);
          const best = candidates
            .map((c) => ({ c, sim: cosine(vector, c.embedding ?? []) }))
            .sort((a, b) => b.sim - a.sim)[0];
          // Reworded questions only match when they mention the same numbers and emails (order ids,
          // amounts, accounts), so one customer's answer can't be served for another customer's order.
          if (best && best.sim >= SIMILARITY && sameIdentifiers(input, best.c.input)) hit = best.c;
        }
      }
      if (!hit) return null;
      await db
        .update(responseCache)
        .set({ hits: sql`${responseCache.hits} + 1` })
        .where(eq(responseCache.id, hit.id));
      return hit.answer;
    },

    async store(q, answer) {
      const cfg = await settings();
      // Zero retention: never keep questions or answers.
      if (!cfg || cfg.zeroRetention) return;
      const { contextHash, input } = keyOf(q);
      const embedding = cfg.similar ? await embed(input) : null;
      const expiresAt = new Date(Date.now() + Math.max(1, cfg.ttlHours) * 3_600_000);
      await db
        .insert(responseCache)
        .values({
          workspaceId,
          flowId: q.flowId,
          nodeId: q.nodeId,
          contextHash,
          inputHash: sha(input),
          input: input.slice(0, 2000),
          embedding,
          answer,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [
            responseCache.workspaceId,
            responseCache.flowId,
            responseCache.nodeId,
            responseCache.contextHash,
            responseCache.inputHash,
          ],
          set: { answer, embedding, expiresAt },
        });
    },
  };
}

/** Removes expired answers (run with the hourly retention sweep). */
export async function purgeExpiredCache(db: Db, now = new Date()) {
  const gone = await db
    .delete(responseCache)
    .where(lt(responseCache.expiresAt, now))
    .returning({ id: responseCache.id });
  return gone.length;
}

/** Hit counts per flow for the Settings page. */
export async function cacheStats(db: Db, workspaceId: string) {
  const [row] = await db
    .select({ entries: sql<number>`count(*)::int`, hits: sql<number>`coalesce(sum(${responseCache.hits}), 0)::int` })
    .from(responseCache)
    .where(and(eq(responseCache.workspaceId, workspaceId), gt(responseCache.expiresAt, new Date())));
  return { entries: row?.entries ?? 0, hits: row?.hits ?? 0 };
}
