import { startDemoServer } from "../src/demo-server";

const port = Number(process.env.DEMO_MCP_PORT ?? 4020);
await startDemoServer(port);
console.log(`✓ Demo orders MCP server on http://localhost:${port}/mcp (tools: get_order, list_orders, request_refund)`);
