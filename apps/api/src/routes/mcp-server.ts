import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { flowVersions, flows } from "@agentflow/db";
import { Flow } from "@agentflow/flow-schema";
import { z } from "zod";
import { HttpError, currentWorkspace } from "../auth";
import type { Deps } from "../app";

/** `description` tells calling AI tools when to use this flow. */
type McpSettings = { tokenHash: string; createdAt: string; description?: string };
const mcpOf = (settings: Record<string, unknown>) => settings.mcp as McpSettings | undefined;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A tool name MCP clients accept: lowercase letters, digits and underscores. */
export const toolNameFor = (flowName: string) =>
  (
    flowName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "run_$1") || "run_flow"
  ).slice(0, 64);

/**
 * Flows as MCP servers (MS-1): each published flow can be offered to other AI tools (Claude, IDEs, agents) as a
 * Streamable HTTP MCP server with one tool that runs the live version. Clients authenticate with the flow's token.
 */
export async function mcpServerRoutes(app: FastifyInstance, { db, auth, executor, billing, config }: Deps) {
  const urlFor = (flowId: string) => `${config.publicApiUrl}/v1/mcp/${flowId}`;
  const findFlow = async (workspaceId: string, id: string) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId)));
    if (!flow) throw new HttpError(404, "Flow not found");
    return flow;
  };

  // --- Management ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/flows/:id/mcp",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const mcp = mcpOf(flow.settings);
      return {
        enabled: Boolean(mcp),
        url: urlFor(flow.id),
        toolName: toolNameFor(flow.name),
        description: mcp?.description ?? null,
        since: mcp?.createdAt ?? null,
      };
    },
  );

  /** Turns the MCP server on (or rotates its token). The token is shown once. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/mcp",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const { description } = z.object({ description: z.string().trim().max(500).optional() }).parse(req.body ?? {});
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const token = `afm_${randomBytes(32).toString("base64url")}`;
      const mcp: McpSettings = {
        tokenHash: sha(token),
        createdAt: new Date().toISOString(),
        ...(description && { description }),
      };
      await db
        .update(flows)
        .set({ settings: { ...flow.settings, mcp } })
        .where(eq(flows.id, flow.id));
      return { url: urlFor(flow.id), token, toolName: toolNameFor(flow.name) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/flows/:id/mcp",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      await db
        .update(flows)
        .set({ settings: { ...flow.settings, mcp: undefined } })
        .where(eq(flows.id, flow.id));
      return reply.code(204).send();
    },
  );

  // --- The MCP endpoint ---------------------------------------------------------------------

  app.post<{ Params: { flowId: string } }>("/mcp/:flowId", async (req, reply) => {
    const [flow] = await db.select().from(flows).where(eq(flows.id, req.params.flowId));
    const mcp = flow && mcpOf(flow.settings);
    const given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const ok =
      mcp && given && Buffer.byteLength(sha(given)) === Buffer.byteLength(mcp.tokenHash)
        ? timingSafeEqual(Buffer.from(sha(given)), Buffer.from(mcp.tokenHash))
        : false;
    if (!flow || !ok) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="agentflow"')
        .send({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    }
    const toolName = toolNameFor(flow.name);
    const description =
      mcp!.description ||
      `Ask the "${flow.name}" assistant. Send the request in plain language; it replies with its answer.`;

    const server = new Server({ name: toolName, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: toolName,
          description,
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string", description: "What to ask or tell the assistant" },
              inputs: {
                type: "object",
                description: "Optional extra fields, available to the flow as {{trigger.<name>}}",
                additionalProperties: true,
              },
            },
            required: ["message"],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
      if (call.params.name !== toolName) return text(`Unknown tool ${call.params.name}`, true);
      const args = (call.params.arguments ?? {}) as { message?: unknown; inputs?: Record<string, unknown> };
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!message) return text("Send a message", true);
      if (!flow.liveVersionId) return text("This flow is not published yet", true);
      try {
        await billing.checkConversationLimit(flow.workspaceId);
      } catch (error) {
        return text((error as Error).message, true);
      }
      const [version] = await db.select().from(flowVersions).where(eq(flowVersions.id, flow.liveVersionId));
      const replies: string[] = [];
      let output: unknown = null;
      let error: string | null = null;
      let paused: string | null = null;
      const runId = await executor.start(
        {
          workspaceId: flow.workspaceId,
          flowId: flow.id,
          flowVersionId: version!.id,
          flow: Flow.parse(version!.json),
          triggerType: "api",
          input: { ...(args.inputs ?? {}), message, channel: "mcp" },
        },
        (e) => {
          if (e.type === "message") replies.push(e.content);
          if (e.type === "done") output = e.output ?? null;
          if (e.type === "error") error = e.message;
          if (e.type === "paused") paused = e.reason;
        },
      );
      if (error) return text(`The flow failed: ${error}`, true);
      const parts = [...replies];
      if (output !== null && output !== undefined && !(typeof output === "object" && !Object.keys(output).length))
        parts.push(JSON.stringify(output));
      if (paused === "approval") parts.push(`(Waiting for a team member's approval; run ${runId}.)`);
      else if (paused) parts.push(`(The flow is waiting (${paused}); run ${runId}.)`);
      return text(parts.join("\n\n") || "(The flow finished without a reply.)");
    });

    // Stateless Streamable HTTP: a fresh server and transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless servers have no event stream or sessions to close.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp/:flowId",
      handler: async (_req, reply) =>
        reply
          .code(405)
          .header("allow", "POST")
          .send({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null }),
    });
  }
}
