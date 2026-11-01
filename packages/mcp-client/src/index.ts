import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type ConnectorConfig =
  { transport: "http"; url: string } | { transport: "stdio"; command: string; args?: string[]; cwd?: string };

export type ConnectorAuth =
  { type: "none" } | { type: "bearer"; token: string } | { type: "header"; header: string; value: string };

export type ToolMode = "read" | "write" | "destructive";

export type ToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mode: ToolMode;
};

export type ToolResult = { text: string; data: unknown; isError: boolean };

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean };

/** Read-only tools are "read"; destructive ones "destructive"; anything unannotated is treated as "write". */
export function classifyTool(annotations?: Annotations): ToolMode {
  if (annotations?.destructiveHint) return "destructive";
  if (annotations?.readOnlyHint) return "read";
  return "write";
}

const authHeaders = (auth: ConnectorAuth): Record<string, string> =>
  auth.type === "bearer"
    ? { authorization: `Bearer ${auth.token}` }
    : auth.type === "header"
      ? { [auth.header]: auth.value }
      : {};

/** Only a minimal, explicit environment reaches local (stdio) servers — never the platform's secrets. */
function stdioEnv(): Record<string, string> {
  const keep = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
}

export async function connect(config: ConnectorConfig, auth: ConnectorAuth = { type: "none" }): Promise<Client> {
  const client = new Client({ name: "agentflow", version: "0.1.0" });
  const transport =
    config.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: authHeaders(auth) } })
      : new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: stdioEnv(),
        });
  await client.connect(transport);
  return client;
}

export async function listTools(client: Client): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      tools.push({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
        mode: classifyTool(t.annotations as Annotations | undefined),
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  let data: unknown = result.structuredContent;
  if (data === undefined) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { text, data, isError: Boolean(result.isError) };
}

/** Keeps one connection per connector and closes connections that sit idle. */
export class McpConnectionPool {
  private entries = new Map<string, { client: Promise<Client>; timer?: NodeJS.Timeout }>();

  constructor(private idleMs = 5 * 60_000) {}

  async get(key: string, config: ConnectorConfig, auth?: ConnectorAuth): Promise<Client> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { client: connect(config, auth) };
      entry.client.catch(() => this.entries.delete(key));
      this.entries.set(key, entry);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.close(key), this.idleMs);
    entry.timer.unref?.();
    return entry.client;
  }

  async close(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    await (await entry.client.catch(() => null))?.close().catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.entries.keys()].map((k) => this.close(k)));
  }
}
