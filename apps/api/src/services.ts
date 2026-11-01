import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, asc, eq } from "drizzle-orm";
import { connectors, providerKeys, type Db } from "@agentflow/db";
import { LLMGateway, type Price, type ProviderId } from "@agentflow/llm-gateway";
import { McpConnectionPool, callTool, type ConnectorAuth, type ConnectorConfig } from "@agentflow/mcp-client";
import type { ToolProvider } from "@agentflow/runtime";
import type { SecretStore } from "@agentflow/secret-store";

/** Per-workspace model gateway: uses the workspace's own provider keys (BYOK). */
export function makeGatewayFor(db: Db, secrets: SecretStore, prices: Record<string, Price>) {
  return (workspaceId: string) =>
    new LLMGateway({
      prices,
      resolveCredentials: async (provider: ProviderId) => {
        const [key] = await db
          .select()
          .from(providerKeys)
          .where(and(eq(providerKeys.workspaceId, workspaceId), eq(providerKeys.provider, provider)))
          .orderBy(asc(providerKeys.createdAt))
          .limit(1);
        return key ? { apiKey: secrets.decrypt(key.encSecret), baseUrl: key.baseUrl } : null;
      },
    });
}

export function connectorAuth(
  secrets: SecretStore,
  row: { authType: string; encCredentials: string | null },
): ConnectorAuth {
  if (row.authType === "none" || !row.encCredentials) return { type: "none" };
  return JSON.parse(secrets.decrypt(row.encCredentials)) as ConnectorAuth;
}

/** LLM tool names must match ^[a-zA-Z0-9_-]{1,64}$ and be unique within one request. */
function toolName(name: string, used: Set<string>) {
  const base = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "tool";
  let candidate = base;
  for (let i = 2; used.has(candidate); i++) candidate = `${base}_${i}`;
  used.add(candidate);
  return candidate;
}

/** Tools for agents and MCP Tool nodes, backed by the workspace's connectors. */
export function makeToolsFor(db: Db, secrets: SecretStore, pool: McpConnectionPool) {
  return (workspaceId: string): ToolProvider => {
    const load = async (connectorId: string) => {
      const [row] = await db
        .select()
        .from(connectors)
        .where(and(eq(connectors.id, connectorId), eq(connectors.workspaceId, workspaceId)));
      if (!row) throw new Error(`Connector ${connectorId} not found in this workspace`);
      return row;
    };
    return {
      async describe(refs) {
        const used = new Set<string>();
        const out = [];
        for (const ref of refs) {
          const [connectorId, tool] = ref.split("/") as [string, string];
          const row = await load(connectorId);
          const info = row.toolCatalog.find((t) => t.name === tool);
          if (!info) throw new Error(`Tool ${tool} is not available on connector "${row.name}"`);
          out.push({
            ref,
            name: toolName(info.name, used),
            description: info.description,
            inputSchema: info.inputSchema,
          });
        }
        return out;
      },
      async call(ref, args) {
        const [connectorId, tool] = ref.split("/") as [string, string];
        const row = await load(connectorId);
        if (!row.toolCatalog.some((t) => t.name === tool)) {
          throw new Error(`Tool ${tool} is not available on connector "${row.name}"`);
        }
        const client = await pool.get(row.id, row.config as ConnectorConfig, connectorAuth(secrets, row));
        return callTool(client, tool, args);
      },
    };
  };
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
const isPrivate = (ip: string): boolean =>
  isIP(ip) === 6
    ? ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || (ip.startsWith("::ffff:") && isPrivate(ip.slice(7)))
    : PRIVATE_V4.some((r) => r.test(ip));

/** Rejects URLs that resolve to private or loopback addresses (basic SSRF protection). */
export async function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (host === "localhost" || addresses.some(isPrivate)) {
    throw new Error(
      `Requests to private addresses are blocked (${url.hostname}). Set ALLOW_PRIVATE_HTTP=true for local development.`,
    );
  }
}

/** fetch for HTTP nodes; private addresses are refused unless ALLOW_PRIVATE_HTTP=true. */
export function makeGuardedFetch(allowPrivate: boolean): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!allowPrivate) await assertPublicUrl(url);
    return fetch(input, { ...init, redirect: "manual" });
  };
}
