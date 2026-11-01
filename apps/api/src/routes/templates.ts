import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { connectors, flows, newId } from "@agentflow/db";
import { ModelRef } from "@agentflow/flow-schema";
import { getTemplate, templates } from "@agentflow/templates";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";

const Install = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  model: ModelRef,
  connectorId: z.string().optional(),
});

export async function templateRoutes(app: FastifyInstance, { db, auth }: Deps) {
  app.get("/templates", { preHandler: auth.requireWorkspace("viewer") }, async () => ({
    templates: templates.map(({ build: _build, ...meta }) => meta),
  }));

  /** Install wizard result: creates a draft flow from the template with the chosen model and connector. */
  app.post<{ Params: { slug: string } }>(
    "/templates/:slug/install",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const template = getTemplate(req.params.slug);
      if (!template) throw new HttpError(404, "Template not found");
      const body = Install.parse(req.body);
      const ws = currentWorkspace(req);
      if (template.connector) {
        if (!body.connectorId) throw new HttpError(400, `Choose a connector for "${template.connector.label}"`);
        const [connector] = await db
          .select()
          .from(connectors)
          .where(and(eq(connectors.id, body.connectorId), eq(connectors.workspaceId, ws.id)));
        if (!connector) throw new HttpError(404, "Connector not found");
        const missing = template.connector.tools.filter((t) => !connector.toolCatalog.some((c) => c.name === t));
        if (missing.length) throw new HttpError(400, `Connector "${connector.name}" has no ${missing.join(", ")} tool`);
      }
      const id = newId("flw");
      const name = body.name ?? template.name;
      const draft = template.build({ id, name, model: body.model, connectorId: body.connectorId });
      await db.insert(flows).values({ id, workspaceId: ws.id, name, draftJson: draft, createdBy: currentUser(req).id });
      return reply.code(201).send({ id, name });
    },
  );
}
