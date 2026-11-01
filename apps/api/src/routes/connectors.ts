import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { connectors } from "@agentflow/db";
import { callTool, connect, listTools, type ConnectorAuth, type ConnectorConfig } from "@agentflow/mcp-client";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { assertPublicUrl, connectorAuth } from "../services";

const Auth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  z.object({ type: z.literal("header"), header: z.string().min(1).max(100), value: z.string().min(1) }),
]);

const CreateConnector = z.object({
  name: z.string().trim().min(1).max(80),
  config: z.discriminatedUnion("transport", [
    z.object({ transport: z.literal("http"), url: z.url() }),
    z.object({
      transport: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
    }),
  ]),
  auth: Auth.default({ type: "none" }),
});

const TestTool = z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) });

const publicColumns = {
  id: connectors.id,
  name: connectors.name,
  transport: connectors.transport,
  config: connectors.config,
  authType: connectors.authType,
  toolCatalog: connectors.toolCatalog,
  refreshedAt: connectors.refreshedAt,
  createdAt: connectors.createdAt,
};

async function discover(config: ConnectorConfig, auth: ConnectorAuth) {
  let client;
  try {
    client = await connect(config, auth);
    return await listTools(client);
  } catch (error) {
    throw new HttpError(422, `Could not connect to the MCP server: ${(error as Error).message}`);
  } finally {
    await client?.close().catch(() => {});
  }
}

/** MCP connector hub: connect servers, discover their tools, try tools out. */
export async function connectorRoutes(app: FastifyInstance, { db, auth, secrets, pool, config }: Deps) {
  const find = async (workspaceId: string, id: string) => {
    const [row] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, id), eq(connectors.workspaceId, workspaceId)));
    if (!row) throw new HttpError(404, "Connector not found");
    return row;
  };

  app.get("/connectors", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const rows = await db
      .select(publicColumns)
      .from(connectors)
      .where(eq(connectors.workspaceId, currentWorkspace(req).id))
      .orderBy(desc(connectors.createdAt));
    return { connectors: rows };
  });

  app.post("/connectors", { preHandler: auth.requireWorkspace("admin") }, async (req, reply) => {
    const body = CreateConnector.parse(req.body);
    if (body.config.transport === "stdio" && !config.allowStdioMcp) {
      throw new HttpError(400, "Local (stdio) MCP servers are only allowed in development (ALLOW_STDIO_MCP=true)");
    }
    if (body.config.transport === "http" && !config.allowPrivateHttp) {
      await assertPublicUrl(body.config.url).catch((e: Error) => {
        throw new HttpError(400, e.message);
      });
    }
    const tools = await discover(body.config, body.auth);
    const [row] = await db
      .insert(connectors)
      .values({
        workspaceId: currentWorkspace(req).id,
        name: body.name,
        transport: body.config.transport,
        config: body.config,
        authType: body.auth.type,
        encCredentials: body.auth.type === "none" ? null : secrets.encrypt(JSON.stringify(body.auth)),
        toolCatalog: tools,
        refreshedAt: new Date(),
        createdBy: currentUser(req).id,
      })
      .returning(publicColumns);
    return reply.code(201).send(row);
  });

  app.post<{ Params: { id: string } }>(
    "/connectors/:id/refresh",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const ws = currentWorkspace(req);
      const row = await find(ws.id, req.params.id);
      const tools = await discover(row.config as ConnectorConfig, connectorAuth(secrets, row));
      await pool.close(row.id);
      const [updated] = await db
        .update(connectors)
        .set({ toolCatalog: tools, refreshedAt: new Date() })
        .where(and(eq(connectors.id, row.id), eq(connectors.workspaceId, ws.id)))
        .returning(publicColumns);
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/connectors/:id/test",
    { preHandler: auth.requireWorkspace("builder") },
    async (req) => {
      const { tool, args } = TestTool.parse(req.body);
      const row = await find(currentWorkspace(req).id, req.params.id);
      if (!row.toolCatalog.some((t) => t.name === tool)) throw new HttpError(404, `Tool ${tool} not found`);
      const client = await pool.get(row.id, row.config as ConnectorConfig, connectorAuth(secrets, row));
      return callTool(client, tool, args);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/connectors/:id",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      await find(ws.id, req.params.id);
      await pool.close(req.params.id);
      await db.delete(connectors).where(and(eq(connectors.id, req.params.id), eq(connectors.workspaceId, ws.id)));
      return reply.code(204).send();
    },
  );
}
