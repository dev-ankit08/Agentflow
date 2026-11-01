import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prompts } from "@agentflow/db";
import { checkTemplate } from "@agentflow/expression-engine";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";

const PromptBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  body: z
    .string()
    .min(1)
    .max(20_000)
    .refine((b) => !/\{\{[^}]*\bsecret\./.test(b), "Secrets cannot be used in prompts")
    .refine((b) => checkTemplate(b).length === 0, "The prompt has an unclosed {{#if}} or {{ }} block"),
});

/** Prompt library: reusable prompts that agents in any flow of the workspace can start from. */
export async function promptRoutes(app: FastifyInstance, { db, auth }: Deps) {
  const find = async (workspaceId: string, id: string) => {
    const [row] = await db
      .select()
      .from(prompts)
      .where(and(eq(prompts.id, id), eq(prompts.workspaceId, workspaceId)));
    if (!row) throw new HttpError(404, "Prompt not found");
    return row;
  };

  app.get("/prompts", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const rows = await db
      .select()
      .from(prompts)
      .where(eq(prompts.workspaceId, currentWorkspace(req).id))
      .orderBy(asc(prompts.name));
    return { prompts: rows };
  });

  app.post("/prompts", { preHandler: auth.requireWorkspace("builder") }, async (req, reply) => {
    const body = PromptBody.parse(req.body);
    const [row] = await db
      .insert(prompts)
      .values({ ...body, workspaceId: currentWorkspace(req).id, createdBy: currentUser(req).id })
      .returning();
    return reply.code(201).send(row);
  });

  app.put<{ Params: { id: string } }>("/prompts/:id", { preHandler: auth.requireWorkspace("builder") }, async (req) => {
    const body = PromptBody.parse(req.body);
    const ws = currentWorkspace(req);
    await find(ws.id, req.params.id);
    const [row] = await db
      .update(prompts)
      .set({ ...body, description: body.description ?? null, updatedAt: new Date() })
      .where(and(eq(prompts.id, req.params.id), eq(prompts.workspaceId, ws.id)))
      .returning();
    return row;
  });

  app.delete<{ Params: { id: string } }>(
    "/prompts/:id",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await find(ws.id, req.params.id);
      await db.delete(prompts).where(and(eq(prompts.id, req.params.id), eq(prompts.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );
}
