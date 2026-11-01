import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { flows, newId } from "@agentflow/db";
import { blankFlow, validateFlow, type FlowInput } from "@agentflow/flow-schema";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";

const CreateFlow = z.object({ name: z.string().trim().min(1).max(120) });
/** Drafts may be invalid while being edited; only the outer shape is required to save. */
const SaveDraft = z.object({
  draft: z.looseObject({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }),
  /** When the editor last loaded or saved the draft; a newer save by someone else is a conflict. */
  baseUpdatedAt: z.string().datetime({ offset: true }).optional(),
  force: z.boolean().optional(),
});

export async function flowRoutes(app: FastifyInstance, { db, auth }: Deps) {
  const findFlow = async (workspaceId: string, id: string) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId)));
    if (!flow) throw new HttpError(404, "Flow not found");
    return flow;
  };

  app.get("/flows", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const ws = currentWorkspace(req);
    const rows = await db
      .select({ id: flows.id, name: flows.name, liveVersionId: flows.liveVersionId, updatedAt: flows.updatedAt })
      .from(flows)
      .where(eq(flows.workspaceId, ws.id))
      .orderBy(desc(flows.updatedAt));
    return { flows: rows };
  });

  app.post("/flows", { preHandler: auth.requireWorkspace("builder") }, async (req, reply) => {
    const { name } = CreateFlow.parse(req.body);
    const ws = currentWorkspace(req);
    const id = newId("flw");
    const [flow] = await db
      .insert(flows)
      .values({ id, workspaceId: ws.id, name, draftJson: blankFlow(id, name), createdBy: currentUser(req).id })
      .returning({ id: flows.id, name: flows.name });
    return reply.code(201).send(flow);
  });

  app.get<{ Params: { id: string } }>("/flows/:id", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const flow = await findFlow(currentWorkspace(req).id, req.params.id);
    const { errors, warnings } = validateFlow(flow.draftJson);
    return { ...flow, validation: { ok: errors.length === 0, errors, warnings } };
  });

  app.put<{ Params: { id: string } }>(
    "/flows/:id/draft",
    { preHandler: auth.requireWorkspace("builder") },
    async (req) => {
      const { draft, baseUpdatedAt, force } = SaveDraft.parse(req.body);
      const ws = currentWorkspace(req);
      const flow = await findFlow(ws.id, req.params.id);
      if (baseUpdatedAt && !force && flow.updatedAt.getTime() > new Date(baseUpdatedAt).getTime()) {
        throw new HttpError(409, "Someone else saved this flow while you were editing. Reload to see their changes.");
      }
      const next = { ...draft, id: flow.id } as FlowInput;
      const name = typeof next.name === "string" && next.name.trim() ? next.name.trim() : flow.name;
      next.name = name;
      const updatedAt = new Date();
      await db
        .update(flows)
        .set({ draftJson: next, name, updatedAt })
        .where(and(eq(flows.id, flow.id), eq(flows.workspaceId, ws.id)));
      const { errors, warnings } = validateFlow(next);
      return { id: flow.id, updatedAt, validation: { ok: errors.length === 0, errors, warnings } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/flows/:id",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await findFlow(ws.id, req.params.id);
      await db.delete(flows).where(and(eq(flows.id, req.params.id), eq(flows.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );
}
