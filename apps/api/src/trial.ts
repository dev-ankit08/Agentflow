import { and, eq, notExists, sql } from "drizzle-orm";
import { connectors, providerKeys, workspaces, type Db } from "@agentflow/db";
import { connect, listTools } from "@agentflow/mcp-client";
import { maskSecret, type SecretStore } from "@agentflow/secret-store";

/** Hosted trials only: the bundled demo model and orders server, given to workspaces so templates run at once. */
export type TrialDemo = { modelUrl?: string; mcpUrl?: string };

export const DEMO_MODEL_LABEL = "Demo model (free, canned replies)";
export const DEMO_CONNECTOR_NAME = "Demo orders";

async function demoTools(url: string) {
  const client = await connect({ transport: "http", url }, { type: "none" });
  try {
    return await listTools(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Gives each workspace without a model key the demo model, and each workspace without a connector the demo orders
 * connector (all workspaces, or just `workspaceId`). Workspaces with their own keys or connectors are left alone.
 */
export async function provisionTrialDemo(db: Db, secrets: SecretStore, demo: TrialDemo, workspaceId?: string) {
  const lacking = (table: typeof providerKeys | typeof connectors) =>
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          workspaceId ? eq(workspaces.id, workspaceId) : undefined,
          notExists(
            db
              .select({ one: sql`1` })
              .from(table)
              .where(eq(table.workspaceId, workspaces.id)),
          ),
        ),
      );
  const result = { models: 0, connectors: 0 };

  if (demo.modelUrl) {
    for (const ws of await lacking(providerKeys)) {
      await db.insert(providerKeys).values({
        workspaceId: ws.id,
        provider: "openai_compatible",
        label: DEMO_MODEL_LABEL,
        encSecret: secrets.encrypt("demo"),
        maskedSecret: maskSecret("demo"),
        baseUrl: demo.modelUrl,
      });
      result.models++;
    }
  }

  if (demo.mcpUrl) {
    const targets = await lacking(connectors);
    if (targets.length) {
      const tools = await demoTools(demo.mcpUrl);
      for (const ws of targets) {
        await db.insert(connectors).values({
          workspaceId: ws.id,
          name: DEMO_CONNECTOR_NAME,
          transport: "http",
          config: { transport: "http", url: demo.mcpUrl },
          toolCatalog: tools,
          refreshedAt: new Date(),
        });
        result.connectors++;
      }
    }
  }
  return result;
}
