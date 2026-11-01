"use client";

import { useState } from "react";
import { Button, Select } from "@agentflow/ui";

type Tool = { name: string; inputSchema: Record<string, unknown> };

function exampleArgs(schema: Record<string, unknown>) {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(props).map(([k, p]) => [k, p.type === "number" ? 0 : p.type === "boolean" ? false : ""]),
    ),
    null,
    2,
  );
}

/** Calls a connector tool with sample arguments and shows the raw result. */
export function ToolTester({ connectorId, tools }: { connectorId: string; tools: Tool[] }) {
  const [tool, setTool] = useState(tools[0]?.name ?? "");
  const [args, setArgs] = useState(exampleArgs(tools[0]?.inputSchema ?? {}));
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/connectors/${connectorId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args: JSON.parse(args || "{}") }),
      });
      const body = await res.json();
      setResult(JSON.stringify(res.ok ? body : { error: body.error ?? res.statusText }, null, 2));
    } catch (error) {
      setResult(`Error: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label htmlFor={`tool-${connectorId}`} className="sr-only">
          Tool
        </label>
        <Select
          id={`tool-${connectorId}`}
          value={tool}
          className="h-8 text-xs"
          onChange={(e) => {
            setTool(e.target.value);
            setArgs(exampleArgs(tools.find((t) => t.name === e.target.value)?.inputSchema ?? {}));
            setResult(null);
          }}
        >
          {tools.map((t) => (
            <option key={t.name}>{t.name}</option>
          ))}
        </Select>
        <Button size="sm" variant="secondary" onClick={run} disabled={busy || !tool}>
          {busy ? "Calling…" : "Try tool"}
        </Button>
      </div>
      <textarea
        aria-label="Arguments (JSON)"
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text focus:border-accent focus:outline-none"
      />
      {result && (
        <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] text-text">
          {result}
        </pre>
      )}
    </div>
  );
}
