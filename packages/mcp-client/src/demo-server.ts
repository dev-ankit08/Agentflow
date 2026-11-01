import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * A small "orders" MCP server with sample data, for demos, templates and tests.
 * Tools: get_order (read), list_orders (read), request_refund (write).
 */
const orders: Record<string, { status: string; eta: string | null; total: number; items: string[] }> = {
  "1042": { status: "shipped", eta: "Thursday", total: 640, items: ["Desk lamp", "Monitor arm"] },
  "1043": { status: "processing", eta: "next week", total: 89, items: ["USB-C cable"] },
  "1044": { status: "delivered", eta: null, total: 1250, items: ["Standing desk"] },
};

const tools = [
  {
    name: "get_order",
    description: "Look up an order by its id. Returns status, delivery estimate, total and items.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string", description: "Order id, e.g. 1042" } },
      required: ["order_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_orders",
    description: "List all order ids with their status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "request_refund",
    description: "Open a refund request for an order.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" }, reason: { type: "string" } },
      required: ["order_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

function buildServer() {
  const server = new Server({ name: "demo-orders", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    const reply = (data: unknown, isError = false) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      isError,
    });
    switch (req.params.name) {
      case "get_order": {
        const order = orders[String(args.order_id ?? "").replace(/\D/g, "")];
        return order
          ? reply({ order_id: args.order_id, ...order })
          : reply({ error: `Order ${args.order_id} not found` }, true);
      }
      case "list_orders":
        return reply(Object.entries(orders).map(([id, o]) => ({ order_id: id, status: o.status })));
      case "request_refund":
        return reply({ refund_request_id: `RF-${args.order_id}`, status: "opened" });
      default:
        return reply({ error: `Unknown tool ${req.params.name}` }, true);
    }
  });
  return server;
}

/** Starts the demo server (stateless Streamable HTTP) at http://localhost:<port>/mcp. */
export function startDemoServer(port: number): Promise<HttpServer> {
  const http = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  return new Promise((resolve) => http.listen(port, () => resolve(http)));
}
