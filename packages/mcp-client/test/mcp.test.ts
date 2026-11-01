import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpConnectionPool, callTool, classifyTool, listTools } from "../src";
import { startDemoServer } from "../src/demo-server";

const port = 4920;
let http: Server;
const pool = new McpConnectionPool();
const config = { transport: "http" as const, url: `http://localhost:${port}/mcp` };

beforeAll(async () => {
  http = await startDemoServer(port);
});
afterAll(async () => {
  await pool.closeAll();
  await new Promise((r) => http.close(r));
});

describe("MCP client", () => {
  it("discovers tools with read/write classification", async () => {
    const client = await pool.get("demo", config);
    const tools = await listTools(client);
    expect(tools.map((t) => [t.name, t.mode])).toEqual([
      ["get_order", "read"],
      ["list_orders", "read"],
      ["request_refund", "write"],
    ]);
    expect(tools[0]!.inputSchema).toMatchObject({ required: ["order_id"] });
  });

  it("calls tools and parses JSON results", async () => {
    const client = await pool.get("demo", config);
    const ok = await callTool(client, "get_order", { order_id: "1042" });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ status: "shipped", eta: "Thursday" });
    const missing = await callTool(client, "get_order", { order_id: "9" });
    expect(missing.isError).toBe(true);
  });

  it("reuses pooled connections", async () => {
    expect(await pool.get("demo", config)).toBe(await pool.get("demo", config));
  });

  it("classifies unannotated tools as write", () => {
    expect(classifyTool(undefined)).toBe("write");
    expect(classifyTool({ readOnlyHint: true })).toBe("read");
    expect(classifyTool({ destructiveHint: true })).toBe("destructive");
  });
});
