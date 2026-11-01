import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { ToolTester } from "@/components/tool-tester";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { addConnector, deleteConnector, refreshConnector } from "../../actions";

type Connector = {
  id: string;
  name: string;
  config: { url?: string; command?: string };
  authType: string;
  toolCatalog: { name: string; description: string; mode: string; inputSchema: Record<string, unknown> }[];
  refreshedAt: string | null;
};

const modeTone = { read: "success", write: "warning", destructive: "danger" } as const;

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { current } = await requireWorkspace();
  const { connectors } = await apiFetch<{ connectors: Connector[] }>("/v1/connectors", { workspaceId: current.id });
  const isAdmin = can(current, "admin");
  const canTest = can(current, "builder");
  const { error, ok } = await searchParams;

  return (
    <>
      <PageHeader
        title="Connectors"
        description="Connect MCP servers so agents can read and act on your business data."
      />
      <Flash error={error} ok={ok} />

      <div className="space-y-6">
        {connectors.length === 0 && (
          <EmptyState
            title="No connectors yet"
            description="Add any MCP server URL below. For a quick demo, run `corepack pnpm demo:mcp` and add http://localhost:4020/mcp."
          />
        )}

        {connectors.map((c) => (
          <Card key={c.id}>
            <CardHeader
              title={c.name}
              subtitle={
                <span className="font-mono text-xs">
                  {c.config.url ?? c.config.command} · auth: {c.authType}
                  {c.refreshedAt && ` · refreshed ${new Date(c.refreshedAt).toLocaleString()}`}
                </span>
              }
              action={
                isAdmin && (
                  <div className="flex gap-2">
                    <form action={refreshConnector}>
                      <input type="hidden" name="id" value={c.id} />
                      <Button type="submit" variant="secondary" size="sm">
                        Refresh tools
                      </Button>
                    </form>
                    <form action={deleteConnector}>
                      <input type="hidden" name="id" value={c.id} />
                      <Button type="submit" variant="danger" size="sm">
                        Delete
                      </Button>
                    </form>
                  </div>
                )
              }
            />
            <div className="grid gap-0 lg:grid-cols-[1.3fr_1fr]">
              <ul className="divide-y divide-border">
                {c.toolCatalog.map((t) => (
                  <li key={t.name} className="flex items-start justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm text-text">{t.name}</p>
                      <p className="text-xs text-muted">{t.description}</p>
                    </div>
                    <Badge tone={modeTone[t.mode as keyof typeof modeTone] ?? "neutral"}>{t.mode}</Badge>
                  </li>
                ))}
              </ul>
              {canTest && c.toolCatalog.length > 0 && (
                <CardBody className="border-t border-border lg:border-l lg:border-t-0">
                  <p className="mb-2 text-sm font-medium text-text">Try a tool</p>
                  <ToolTester connectorId={c.id} tools={c.toolCatalog} />
                </CardBody>
              )}
            </div>
          </Card>
        ))}

        {isAdmin && (
          <Card>
            <CardHeader
              title="Add an MCP server"
              description="Streamable HTTP endpoint. Tools are discovered automatically."
            />
            <CardBody>
              <form action={addConnector} className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="c-name">
                  <Input id="c-name" name="name" required maxLength={80} placeholder="Orders system" />
                </Field>
                <Field label="Server URL" htmlFor="c-url">
                  <Input id="c-url" name="url" type="url" required placeholder="https://mcp.example.com/mcp" />
                </Field>
                <Field label="Authentication" htmlFor="c-auth">
                  <Select id="c-auth" name="authType" defaultValue="none">
                    <option value="none">None</option>
                    <option value="bearer">Bearer token</option>
                    <option value="header">Custom header</option>
                  </Select>
                </Field>
                <Field label="Header name (custom header only)" htmlFor="c-header">
                  <Input id="c-header" name="header" placeholder="x-api-key" />
                </Field>
                <Field label="Token / header value" htmlFor="c-token" hint="Encrypted at rest; never shown again.">
                  <Input id="c-token" name="token" type="password" autoComplete="off" />
                </Field>
                <div className="flex items-end">
                  <Button type="submit">Connect and discover tools</Button>
                </div>
              </form>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
