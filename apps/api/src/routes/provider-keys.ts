import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { providerKeys } from "@agentflow/db";
import { providers } from "@agentflow/flow-schema";
import { maskSecret } from "@agentflow/secret-store";
import { currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";

const needsBaseUrl = new Set(["azure_openai", "openai_compatible"]);
/** Bedrock takes an AWS region (or endpoint URL) and Vertex a Google Cloud location instead of a URL. */
const takesRegion = new Set(["bedrock", "vertex"]);
const REGION = /^[a-z]+(-[a-z0-9]+)+$|^global$/;

const CreateKey = z
  .object({
    provider: z.enum(providers),
    label: z.string().trim().min(1).max(80),
    secret: z.string().trim().min(1).max(8192),
    baseUrl: z.string().trim().min(1).max(500).optional(),
  })
  .refine((k) => !needsBaseUrl.has(k.provider) || k.baseUrl, {
    message: "This provider needs a base URL",
    path: ["baseUrl"],
  })
  .refine((k) => !k.baseUrl || URL.canParse(k.baseUrl) || (takesRegion.has(k.provider) && REGION.test(k.baseUrl)), {
    message: "Use a URL (or, for Bedrock and Vertex, a region such as us-east-1)",
    path: ["baseUrl"],
  });

const publicColumns = {
  id: providerKeys.id,
  provider: providerKeys.provider,
  label: providerKeys.label,
  maskedSecret: providerKeys.maskedSecret,
  baseUrl: providerKeys.baseUrl,
  createdAt: providerKeys.createdAt,
};

/** LLM provider keys (BYOK). Secrets are encrypted at rest and never returned after saving. */
export async function providerKeyRoutes(app: FastifyInstance, { db, auth, secrets }: Deps) {
  /** Which providers have a key, for the model picker (any member; no secrets). */
  app.get("/providers", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const rows = await db
      .selectDistinct({ provider: providerKeys.provider })
      .from(providerKeys)
      .where(eq(providerKeys.workspaceId, currentWorkspace(req).id));
    return { providers: rows.map((r) => r.provider) };
  });

  app.get("/provider-keys", { preHandler: auth.requireWorkspace("admin") }, async (req) => {
    const ws = currentWorkspace(req);
    const keys = await db
      .select(publicColumns)
      .from(providerKeys)
      .where(eq(providerKeys.workspaceId, ws.id))
      .orderBy(desc(providerKeys.createdAt));
    return { keys };
  });

  app.post("/provider-keys", { preHandler: auth.requireWorkspace("admin") }, async (req, reply) => {
    const body = CreateKey.parse(req.body);
    const ws = currentWorkspace(req);
    const [key] = await db
      .insert(providerKeys)
      .values({
        workspaceId: ws.id,
        provider: body.provider,
        label: body.label,
        encSecret: secrets.encrypt(body.secret),
        maskedSecret: maskSecret(body.secret),
        baseUrl: body.baseUrl,
        createdBy: currentUser(req).id,
      })
      .returning(publicColumns);
    return reply.code(201).send(key);
  });

  app.delete<{ Params: { id: string } }>(
    "/provider-keys/:id",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await db.delete(providerKeys).where(and(eq(providerKeys.id, req.params.id), eq(providerKeys.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );
}
