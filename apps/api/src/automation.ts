import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { auditEvents, flowVersions, flows, memories, runSteps, runs, workspaces, type Db } from "@agentflow/db";
import { Flow, cronMatches, parseCron } from "@agentflow/flow-schema";
import type { LLMGateway } from "@agentflow/llm-gateway";
import { extractFacts, scrubState, type RunExecutor, type RunState, type RuntimeServices } from "@agentflow/runtime";

/** Per-flow automation settings kept in `flows.settings` next to the widget settings. */
export type FlowAutomation = {
  /** Webhook trigger (H8): POST /v1/hooks/:key, optionally signed with HMAC-SHA256. */
  webhook?: { key: string; secretEnc?: string };
  /** Last minute each schedule fired, so a restart never runs it twice. */
  scheduleState?: { lastRunAt?: string };
  /** A/B test (prompt versioning): this share of new conversations runs `versionId` instead of the live version. */
  abTest?: { versionId: string; percent: number; startedAt: string };
};

export const automationOf = (settings: Record<string, unknown>) => settings as FlowAutomation;

// --- Audit log (H6) ----------------------------------------------------------------------

export async function audit(
  db: Db,
  req: FastifyRequest,
  action: string,
  target: { type: string; id?: string | null },
  detail: Record<string, unknown> = {},
) {
  await db.insert(auditEvents).values({
    workspaceId: req.workspace!.id,
    actorId: req.user?.id ?? null,
    actorEmail: req.user?.email ?? null,
    action,
    targetType: target.type,
    targetId: target.id ?? null,
    detail,
  });
}

// --- Long-term memory (H7) ---------------------------------------------------------------

export function memoryService(db: Db, workspaceId: string): NonNullable<RuntimeServices["memory"]> {
  return {
    async read(endUserId, query, topK) {
      const tsq = sql`to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', ${query})), ' | '))`;
      const ranked = await db
        .select({ fact: memories.fact })
        .from(memories)
        .where(
          and(eq(memories.workspaceId, workspaceId), eq(memories.endUserId, endUserId), sql`${memories.tsv} @@ ${tsq}`),
        )
        .orderBy(sql`ts_rank_cd(${memories.tsv}, ${tsq}) desc`)
        .limit(topK);
      if (ranked.length) return ranked.map((r) => r.fact);
      // Nothing matched the question: fall back to the most recent facts.
      const recent = await db
        .select({ fact: memories.fact })
        .from(memories)
        .where(and(eq(memories.workspaceId, workspaceId), eq(memories.endUserId, endUserId)))
        .orderBy(sql`${memories.createdAt} desc`)
        .limit(topK);
      return recent.map((r) => r.fact);
    },
    async write(endUserId, facts) {
      const existing = new Set(
        (
          await db
            .select({ fact: memories.fact })
            .from(memories)
            .where(and(eq(memories.workspaceId, workspaceId), eq(memories.endUserId, endUserId)))
        ).map((r) => r.fact.toLowerCase()),
      );
      const fresh = [...new Set(facts.map((f) => f.trim()).filter((f) => f && !existing.has(f.toLowerCase())))];
      if (fresh.length)
        await db.insert(memories).values(fresh.map((fact) => ({ workspaceId, endUserId, fact: fact.slice(0, 500) })));
    },
  };
}

// --- A/B tests ----------------------------------------------------------------------------

/** Picks the version a new conversation runs: the live version, or the challenger for its share of traffic. */
export async function chooseVersion(db: Db, flow: typeof flows.$inferSelect, random = Math.random) {
  const ab = automationOf(flow.settings).abTest;
  const id = ab && random() * 100 < ab.percent ? ab.versionId : flow.liveVersionId;
  if (!id) return null;
  const [version] = await db
    .select()
    .from(flowVersions)
    .where(and(eq(flowVersions.id, id), eq(flowVersions.flowId, flow.id)));
  return version ?? null;
}

// --- Background work ----------------------------------------------------------------------

/** Starts live flows whose schedule matches this minute (UTC). Returns the run ids started. */
export async function runSchedules(db: Db, executor: RunExecutor, now = new Date()) {
  const minute = new Date(now);
  minute.setUTCSeconds(0, 0);
  const rows = await db
    .select({ flow: flows, json: flowVersions.json, versionId: flowVersions.id })
    .from(flows)
    .innerJoin(flowVersions, eq(flowVersions.id, flows.liveVersionId))
    .where(isNotNull(flows.liveVersionId));
  const started: string[] = [];
  for (const { flow, json, versionId } of rows) {
    const schedule = json.triggers?.find((t) => t.type === "schedule");
    if (!schedule) continue;
    let matches = false;
    try {
      matches = cronMatches(parseCron(String(schedule.config?.cron ?? "")), minute);
    } catch {
      continue;
    }
    const last = automationOf(flow.settings).scheduleState?.lastRunAt;
    if (!matches || (last && new Date(last) >= minute)) continue;
    await db
      .update(flows)
      .set({ settings: { ...flow.settings, scheduleState: { lastRunAt: minute.toISOString() } } })
      .where(eq(flows.id, flow.id));
    const input = (schedule.config?.input as Record<string, unknown> | undefined) ?? {};
    const runId = await executor
      .start(
        {
          workspaceId: flow.workspaceId,
          flowId: flow.id,
          flowVersionId: versionId,
          flow: Flow.parse(json),
          triggerType: "schedule",
          input: { ...input, scheduledAt: minute.toISOString() },
        },
        () => {},
      )
      .catch(() => null);
    if (runId) started.push(runId);
  }
  return started;
}

/** Continues runs paused on a Wait node whose time has come. */
export async function resumeDueTimers(db: Db, executor: RunExecutor, now = new Date()) {
  const waiting = await db
    .select({ id: runs.id, state: runs.state })
    .from(runs)
    .where(eq(runs.status, "waiting_timer"));
  let resumed = 0;
  for (const run of waiting) {
    const at = (run.state as unknown as RunState).paused?.resumeAt;
    if (!at || new Date(at) > now) continue;
    // Claim the run first so two sweeps never resume it twice.
    const claimed = await db
      .update(runs)
      .set({ status: "running" })
      .where(and(eq(runs.id, run.id), eq(runs.status, "waiting_timer")))
      .returning({ id: runs.id });
    if (!claimed.length) continue;
    await executor.resume(run.id, { output: { waited: true } }, () => {}).catch(() => {});
    resumed++;
  }
  return resumed;
}

/** Deletes runs older than each workspace's retention period, and scrubs idle chats in zero-retention mode. */
export async function applyRetention(db: Db, now = new Date()) {
  const all = await db.select({ id: workspaces.id, settings: workspaces.settings }).from(workspaces);
  let deleted = 0;
  let scrubbed = 0;
  for (const ws of all) {
    const r = ws.settings.retention;
    if (r?.days) {
      const cutoff = new Date(now.getTime() - r.days * 86_400_000);
      const gone = await db
        .delete(runs)
        .where(and(eq(runs.workspaceId, ws.id), lt(runs.startedAt, cutoff)))
        .returning({ id: runs.id });
      deleted += gone.length;
    }
    if (r?.zeroRetention) {
      // Chats stay open waiting for the next message; once idle for an hour, their transcript goes.
      const idle = new Date(now.getTime() - 3_600_000);
      const open = await db
        .select({ id: runs.id, state: runs.state })
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, ws.id),
            inArray(runs.status, ["waiting_input", "completed", "failed", "handed_off"]),
            lt(runs.startedAt, idle),
            sql`jsonb_array_length(coalesce(${runs.state}->'conversation', '[]'::jsonb)) > 0`,
          ),
        );
      for (const run of open) {
        const { flow, ...state } = run.state as unknown as RunState & { flow: unknown };
        await db
          .update(runs)
          .set({ state: { ...scrubState(state), flow } as unknown as Record<string, unknown> })
          .where(eq(runs.id, run.id));
        scrubbed++;
      }
    }
  }
  return { deleted, scrubbed };
}

/**
 * Learns facts about signed-in customers from conversations that finished or went quiet (H7): for workspaces with
 * memory extraction on, each live conversation idle for `idleMinutes` is summarised into facts once, and again only
 * if it continued afterwards. Runs over budget are skipped until the budget allows.
 */
export async function extractMemories(
  db: Db,
  gatewayFor: (workspaceId: string) => LLMGateway,
  checkBudget: (workspaceId: string) => Promise<void>,
  now = new Date(),
  limit = 10,
) {
  const enabled = await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(sql`(${workspaces.settings}->'memoryExtraction'->>'enabled')::boolean is true`);
  let processed = 0;
  let stored = 0;
  for (const ws of enabled) {
    const cfg = ws.settings.memoryExtraction!;
    try {
      await checkBudget(ws.id);
    } catch {
      continue;
    }
    const cutoff = new Date(now.getTime() - Math.max(1, cfg.idleMinutes) * 60_000);
    const lastActivity = sql<Date>`(select max(${runSteps.endedAt}) from ${runSteps} where ${runSteps.runId} = ${runs.id})`;
    const due = await db
      .select({ id: runs.id, endUserId: runs.endUserId, state: runs.state })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, ws.id),
          isNotNull(runs.endUserId),
          isNotNull(runs.flowVersionId),
          eq(runs.sandbox, false),
          inArray(runs.status, ["waiting_input", "completed", "handed_off"]),
          sql`${lastActivity} < ${cutoff.toISOString()}::timestamptz`,
          sql`(${runs.memoryExtractedAt} is null or ${runs.memoryExtractedAt} < ${lastActivity})`,
        ),
      )
      .limit(limit);
    for (const run of due) {
      processed++;
      const conversation = (run.state as unknown as RunState).conversation ?? [];
      try {
        if (conversation.some((t) => t.role === "user")) {
          const { facts } = await extractFacts(gatewayFor(ws.id), cfg.model, conversation);
          if (facts.length) await memoryService(db, ws.id).write(run.endUserId!, facts);
          stored += facts.length;
        }
      } catch {
        // A failing model is retried only when the conversation continues, so a bad key can't loop every sweep.
      }
      await db.update(runs).set({ memoryExtractedAt: now }).where(eq(runs.id, run.id));
    }
  }
  return { processed, stored };
}
