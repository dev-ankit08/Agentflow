"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardHeader, Input } from "@agentflow/ui";
import { CopyBlock } from "./deploy-tools";

type McpInfo = { enabled: boolean; url: string; toolName: string; description: string | null };

/** Deploy page: offer the published flow to other AI tools (Claude, IDEs, agents) as an MCP server. */
export function McpCard({
  flowId,
  initial,
  canManage,
  live,
}: {
  flowId: string;
  initial: McpInfo;
  canManage: boolean;
  live: boolean;
}) {
  const [info, setInfo] = useState(initial);
  const [token, setToken] = useState<string | null>(null);
  const [description, setDescription] = useState(initial.description ?? "");
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    setError(null);
    const res = await fetch(`/api/v1/flows/${flowId}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(description.trim() ? { description: description.trim() } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error ?? "Could not turn on the MCP server");
    setInfo({ ...info, enabled: true, description: description.trim() || null });
    setToken(body.token);
  }

  async function disable() {
    const res = await fetch(`/api/v1/flows/${flowId}/mcp`, { method: "DELETE" });
    if (!res.ok) return setError("Could not turn off the MCP server");
    setInfo({ ...info, enabled: false });
    setToken(null);
  }

  const shownToken = token ?? "<your token>";
  return (
    <Card>
      <CardHeader
        title="Use from other AI tools (MCP)"
        description="Let Claude, IDE assistants or your own agents call this flow as a tool over the Model Context Protocol."
      />
      <CardBody className="space-y-3">
        {!live && <p className="text-sm text-muted">Publish the flow first; MCP clients run the live version.</p>}
        {info.enabled ? (
          <>
            <p className="text-sm text-text">
              On. Tool name <code className="font-mono">{info.toolName}</code>; address:
            </p>
            <Input readOnly value={info.url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            {token ? (
              <p className="rounded-md bg-warning/10 p-2 text-xs text-warning">
                Token (shown once): <code className="break-all font-mono">{token}</code>
              </p>
            ) : (
              <p className="text-xs text-muted">The token was shown when MCP was turned on. Rotate to get a new one.</p>
            )}
            <p className="text-xs font-medium text-muted">Claude Code</p>
            <CopyBlock
              code={`claude mcp add --transport http ${info.toolName} ${info.url} --header "Authorization: Bearer ${shownToken}"`}
            />
            <p className="text-xs font-medium text-muted">Other clients (Streamable HTTP)</p>
            <CopyBlock
              code={JSON.stringify(
                {
                  mcpServers: {
                    [info.toolName]: {
                      type: "http",
                      url: info.url,
                      headers: { Authorization: `Bearer ${shownToken}` },
                    },
                  },
                },
                null,
                2,
              )}
            />
          </>
        ) : (
          <p className="text-sm text-muted">Off. Turning it on creates a private address and token for this flow.</p>
        )}
        {canManage && (
          <div className="space-y-2 border-t border-border pt-3">
            <Input
              value={description}
              maxLength={500}
              placeholder="When should an AI use this tool? e.g. Answers questions about orders and refunds"
              aria-label="Tool description"
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={enable}>
                {info.enabled ? "Rotate token" : "Turn on MCP server"}
              </Button>
              {info.enabled && (
                <Button size="sm" variant="ghost" onClick={disable}>
                  Turn off
                </Button>
              )}
            </div>
          </div>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardBody>
    </Card>
  );
}
