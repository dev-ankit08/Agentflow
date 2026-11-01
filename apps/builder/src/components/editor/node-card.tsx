"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@agentflow/ui";
import { nodeMeta, outputHandles, type FlowNode } from "./model";

function subtitle(node: FlowNode["data"]["node"]): string {
  switch (node.type) {
    case "agent":
      return node.config.model.name || "choose a model";
    case "decision":
      return `${node.config.outcomes.length + 1} outcomes`;
    case "assignment":
      return node.config.assignments.map((a) => a.variable).join(", ");
    case "mcp_tool":
      return node.config.tool || "choose a tool";
    case "http":
      return `${node.config.method} ${node.config.url.replace(/^https?:\/\//, "")}`;
    case "end":
      return node.config.outcome ?? "reply";
    case "knowledge":
      return node.config.sources.length ? `${node.config.sources.length} source(s)` : "all sources";
    case "approval":
      return `${node.config.approverRole}+ approves`;
    case "handoff":
      return `queue: ${node.config.queue}`;
    case "guardrail":
      return (
        [
          node.config.checks.pii && "PII",
          node.config.checks.injection && "injection",
          node.config.checks.blockedTopics.length && "topics",
        ]
          .filter(Boolean)
          .join(" · ") || "no checks"
      );
    case "subflow":
      return node.config.flowId || "choose a flow";
    case "form":
      return `${node.config.fields.length} field(s)`;
    case "supervisor":
      return node.config.workers.map((w) => w.name).join(", ");
    case "parallel":
      return `${node.config.tasks.length} agents at once`;
    case "loop":
      return `each ${node.config.itemVariable} in ${node.config.items}`;
    case "wait":
      return node.config.until ? `until ${node.config.until}` : `${node.config.minutes ?? 0} min`;
    case "memory":
      return node.config.mode === "read"
        ? "recall facts"
        : node.config.mode === "write"
          ? "save facts"
          : "learn from chat";
    default:
      return "Chat message";
  }
}

export function NodeCard({ data, selected }: NodeProps<FlowNode>) {
  const { node, status, issues, comments } = data;
  const meta = nodeMeta[node.type];
  const handles = outputHandles(node);
  return (
    <div
      className={cn(
        "relative w-[200px] rounded-xl border bg-surface text-left shadow-sm transition",
        selected ? "border-accent ring-2 ring-accent/30" : "border-border",
        status === "running" && "ring-2 ring-warning/60",
        status === "ok" && "border-success",
        status === "error" && "border-danger ring-2 ring-danger/30",
      )}
    >
      {node.type !== "start" && (
        <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-surface !bg-muted" />
      )}
      <div className="flex items-center gap-2 rounded-t-xl px-3 py-2" style={{ background: `${meta.color}1a` }}>
        <span
          className="flex h-6 w-6 items-center justify-center rounded-md text-xs text-white"
          style={{ background: meta.color }}
          aria-hidden
        >
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{node.label}</p>
          <p className="truncate text-[11px] text-muted">{meta.label}</p>
        </div>
        {comments ? (
          <span
            className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white"
            title={`${comments} open comment(s)`}
          >
            💬 {comments}
          </span>
        ) : null}
        {issues ? (
          <span
            className="rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white"
            title={`${issues} issue(s)`}
          >
            {issues}
          </span>
        ) : null}
      </div>
      <div className="px-3 py-2">
        <p className="truncate font-mono text-[11px] text-muted" title={subtitle(node)}>
          {subtitle(node)}
        </p>
        {handles && (
          <ul className="mt-2 space-y-1.5">
            {handles.map((h) => (
              <li key={h.id} className="relative pr-3 text-right text-[11px] text-text">
                {h.label}
                <Handle
                  id={h.id}
                  type="source"
                  position={Position.Right}
                  className="!-right-[17px] !h-3 !w-3 !border-2 !border-surface !bg-warning"
                  style={{ top: "50%" }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {!handles && node.type !== "end" && node.type !== "handoff" && (
        <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-surface !bg-accent" />
      )}
    </div>
  );
}
