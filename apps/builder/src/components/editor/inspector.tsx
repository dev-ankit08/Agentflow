"use client";

import type { FlowInput, NodeDef } from "@agentflow/flow-schema";
import { outcomeTags } from "@agentflow/flow-schema";
import { Badge, Button, Input, Select } from "@agentflow/ui";
import { FormulaField, ModelPicker, Row, SchemaBuilder, TemplateField } from "./fields";
import { ExtraFields, type FlowSummary, type SourceSummary } from "./inspector-extra";
import { NodeComments, OrchestrationFields, TriggersPanel, type FlowComment } from "./inspector-orchestration";
import { nodeMeta, type ConnectorSummary } from "./model";

type Props = {
  node: NodeDef;
  onChange: (node: NodeDef) => void;
  onRename: (oldId: string, newId: string) => string | null;
  onDelete: () => void;
  suggestions: { path: string; hint: string }[];
  connectors: ConnectorSummary[];
  configuredProviders: string[];
  issues: string[];
  sources: SourceSummary[];
  flows: FlowSummary[];
  currentFlowId: string;
  readOnly: boolean;
  triggers: FlowInput["triggers"];
  onTriggersChange: (triggers: NonNullable<FlowInput["triggers"]>) => void;
  comments: FlowComment[];
  onAddComment: (nodeId: string, body: string) => Promise<void>;
  onResolveComment: (id: string, resolved: boolean) => Promise<void>;
  canComment: boolean;
};

const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Right-hand properties panel: one form per node type. */
export function Inspector({
  node,
  onChange,
  onRename,
  onDelete,
  suggestions,
  connectors,
  configuredProviders,
  issues,
  readOnly,
  sources,
  flows,
  currentFlowId,
  triggers,
  onTriggersChange,
  comments,
  onAddComment,
  onResolveComment,
  canComment,
}: Props) {
  const meta = nodeMeta[node.type];
  const set = <N extends NodeDef>(patch: (n: N) => N) => onChange(patch(structuredClone(node) as N));

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: meta.color }}>
            {meta.label}
          </p>
          <p className="text-xs text-muted">{meta.hint}</p>
        </div>
        {node.type !== "start" && !readOnly && (
          <Button variant="danger" size="sm" onClick={onDelete} aria-label="Delete node">
            Delete
          </Button>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-danger/10 p-2">
          {issues.map((m, i) => (
            <li key={i} className="text-[11px] text-danger">
              {m}
            </li>
          ))}
        </ul>
      )}

      <Row label="Name">
        <Input
          value={node.label}
          disabled={readOnly}
          className="h-8 text-sm"
          onChange={(e) => set((n) => ({ ...n, label: e.target.value }))}
        />
      </Row>
      <IdField node={node} onRename={onRename} disabled={readOnly || node.type === "start"} />

      {node.type === "start" && (
        <TriggersPanel flowId={currentFlowId} triggers={triggers} onChange={onTriggersChange} readOnly={readOnly} />
      )}

      {node.type === "agent" && (
        <>
          <ModelPicker
            label="Model"
            value={node.config.model}
            configured={configuredProviders}
            disabled={readOnly}
            onChange={(model) => set<typeof node>((n) => ({ ...n, config: { ...n.config, model } }))}
          />
          <Row
            label="System prompt"
            hint="Role, rules and tone. Use {{#if}} blocks to add context only when it applies."
          >
            <TemplateField
              value={node.config.systemPrompt}
              rows={6}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(systemPrompt) => set<typeof node>((n) => ({ ...n, config: { ...n.config, systemPrompt } }))}
            />
          </Row>
          <Row label="User message">
            <TemplateField
              value={node.config.userPrompt}
              rows={2}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(userPrompt) => set<typeof node>((n) => ({ ...n, config: { ...n.config, userPrompt } }))}
            />
          </Row>
          <Row
            label="Structured output"
            hint={`Fields become variables like {{${node.id}.output.field}}. Leave empty for a free-text reply ({{${node.id}.text}}).`}
          >
            <SchemaBuilder
              value={node.config.outputSchema}
              disabled={readOnly}
              onChange={(outputSchema) => set<typeof node>((n) => ({ ...n, config: { ...n.config, outputSchema } }))}
            />
          </Row>
          <Row label="Tools the agent may call" hint="The model can only call tools ticked here.">
            {connectors.length === 0 ? (
              <p className="text-[11px] text-muted">Connect an MCP server on the Connectors page first.</p>
            ) : (
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
                {connectors.map((c) => (
                  <div key={c.id}>
                    <p className="text-[11px] font-medium text-text">{c.name}</p>
                    {c.toolCatalog.map((t) => {
                      const ref = `${c.id}/${t.name}`;
                      const checked = node.config.tools?.includes(ref) ?? false;
                      return (
                        <label
                          key={ref}
                          className="flex items-center gap-1.5 py-0.5 text-[11px] text-text"
                          title={t.description}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={readOnly}
                            onChange={(e) =>
                              set<typeof node>((n) => {
                                const tools = new Set(n.config.tools ?? []);
                                if (e.target.checked) tools.add(ref);
                                else tools.delete(ref);
                                return { ...n, config: { ...n.config, tools: tools.size ? [...tools] : undefined } };
                              })
                            }
                          />
                          <span className="font-mono">{t.name}</span>
                          <Badge tone={t.mode === "read" ? "success" : "warning"} className="!px-1.5 !py-0 !text-[9px]">
                            {t.mode}
                          </Badge>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </Row>
          <details className="rounded-lg border border-border p-2">
            <summary className="cursor-pointer text-xs font-medium text-text">Advanced</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Row label="Temperature">
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    max={2}
                    disabled={readOnly}
                    className="h-8 text-xs"
                    value={node.config.temperature ?? ""}
                    placeholder="default"
                    onChange={(e) =>
                      set<typeof node>((n) => ({
                        ...n,
                        config: {
                          ...n.config,
                          temperature: e.target.value === "" ? undefined : Number(e.target.value),
                        },
                      }))
                    }
                  />
                </Row>
                <Row label="Max tokens">
                  <Input
                    type="number"
                    min={1}
                    disabled={readOnly}
                    className="h-8 text-xs"
                    value={node.config.maxTokens ?? ""}
                    placeholder="1024"
                    onChange={(e) =>
                      set<typeof node>((n) => ({
                        ...n,
                        config: { ...n.config, maxTokens: e.target.value === "" ? undefined : Number(e.target.value) },
                      }))
                    }
                  />
                </Row>
              </div>
              <label className="flex items-center gap-2 text-xs text-text">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={Boolean(node.config.fallbackModel)}
                  onChange={(e) =>
                    set<typeof node>((n) => ({
                      ...n,
                      config: { ...n.config, fallbackModel: e.target.checked ? { ...n.config.model } : undefined },
                    }))
                  }
                />
                Fallback model if the main one fails
              </label>
              {node.config.fallbackModel && (
                <ModelPicker
                  label="Fallback model"
                  value={node.config.fallbackModel}
                  configured={configuredProviders}
                  disabled={readOnly}
                  onChange={(fallbackModel) =>
                    set<typeof node>((n) => ({ ...n, config: { ...n.config, fallbackModel } }))
                  }
                />
              )}
            </div>
          </details>
        </>
      )}

      {node.type === "decision" && (
        <>
          <p className="text-[11px] text-muted">Outcomes are checked top to bottom; the first true condition wins.</p>
          {node.config.outcomes.map((o, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border p-2">
              <div className="flex gap-1">
                <Input
                  value={o.id}
                  aria-label="Outcome id"
                  disabled={readOnly}
                  className="h-8 font-mono text-xs"
                  onChange={(e) =>
                    set<typeof node>((n) => {
                      n.config.outcomes[i]!.id = e.target.value.replace(/[^a-zA-Z0-9_]/g, "");
                      return n;
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readOnly || node.config.outcomes.length === 1}
                  aria-label="Remove outcome"
                  onClick={() =>
                    set<typeof node>((n) => ({
                      ...n,
                      config: { ...n.config, outcomes: n.config.outcomes.filter((_, j) => j !== i) },
                    }))
                  }
                >
                  ×
                </Button>
              </div>
              <FormulaField
                value={o.condition}
                disabled={readOnly}
                suggestions={suggestions}
                placeholder='triage.output.intent == "refund"'
                onChange={(condition) =>
                  set<typeof node>((n) => {
                    n.config.outcomes[i]!.condition = condition;
                    return n;
                  })
                }
              />
            </div>
          ))}
          {!readOnly && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                set<typeof node>((n) => ({
                  ...n,
                  config: {
                    ...n.config,
                    outcomes: [
                      ...n.config.outcomes,
                      { id: `outcome${n.config.outcomes.length + 1}`, condition: "true" },
                    ],
                  },
                }))
              }
            >
              + Add outcome
            </Button>
          )}
          <Row label="Default outcome (when nothing matches)">
            <Input
              value={node.config.defaultOutcome}
              disabled={readOnly}
              className="h-8 font-mono text-xs"
              onChange={(e) =>
                set<typeof node>((n) => ({
                  ...n,
                  config: { ...n.config, defaultOutcome: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") },
                }))
              }
            />
          </Row>
        </>
      )}

      {node.type === "assignment" && (
        <>
          {node.config.assignments.map((a, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border p-2">
              <div className="flex gap-1">
                <Input
                  value={a.variable}
                  aria-label="Variable"
                  placeholder="variable"
                  disabled={readOnly}
                  className="h-8 font-mono text-xs"
                  onChange={(e) =>
                    set<typeof node>((n) => {
                      n.config.assignments[i]!.variable = e.target.value.replace(/[^a-zA-Z0-9_]/g, "");
                      return n;
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readOnly || node.config.assignments.length === 1}
                  aria-label="Remove assignment"
                  onClick={() =>
                    set<typeof node>((n) => ({
                      ...n,
                      config: { ...n.config, assignments: n.config.assignments.filter((_, j) => j !== i) },
                    }))
                  }
                >
                  ×
                </Button>
              </div>
              <FormulaField
                value={a.value}
                disabled={readOnly}
                suggestions={suggestions}
                placeholder="order.amount * 0.1"
                onChange={(value) =>
                  set<typeof node>((n) => {
                    n.config.assignments[i]!.value = value;
                    return n;
                  })
                }
              />
            </div>
          ))}
          {!readOnly && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                set<typeof node>((n) => ({
                  ...n,
                  config: { ...n.config, assignments: [...n.config.assignments, { variable: "", value: '""' }] },
                }))
              }
            >
              + Add assignment
            </Button>
          )}
        </>
      )}

      {node.type === "mcp_tool" && (
        <McpToolForm
          node={node}
          connectors={connectors}
          suggestions={suggestions}
          readOnly={readOnly}
          onChange={onChange}
        />
      )}

      {node.type === "http" && (
        <>
          <div className="grid grid-cols-[90px_1fr] gap-1">
            <Select
              value={node.config.method}
              disabled={readOnly}
              aria-label="Method"
              className="h-8 text-xs"
              onChange={(e) =>
                set<typeof node>((n) => ({
                  ...n,
                  config: { ...n.config, method: e.target.value as typeof n.config.method },
                }))
              }
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
            <Input
              value={node.config.url}
              aria-label="URL"
              disabled={readOnly}
              className="h-8 font-mono text-xs"
              onChange={(e) => set<typeof node>((n) => ({ ...n, config: { ...n.config, url: e.target.value } }))}
            />
          </div>
          <Row label="Body (template)" hint="Secrets may be used here, never in prompts.">
            <TemplateField
              value={node.config.body ?? ""}
              rows={3}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(body) => set<typeof node>((n) => ({ ...n, config: { ...n.config, body: body || undefined } }))}
            />
          </Row>
        </>
      )}

      {node.type === "end" && (
        <>
          <Row label="Reply to the user">
            <TemplateField
              value={node.config.message ?? ""}
              rows={3}
              disabled={readOnly}
              suggestions={suggestions}
              placeholder="{{answer.text}}"
              onChange={(message) => set<typeof node>((n) => ({ ...n, config: { ...n.config, message } }))}
            />
          </Row>
          <Row label="Outcome" hint="Used for the ROI dashboard: resolved, escalated, converted or failed.">
            <Select
              value={node.config.outcome ?? ""}
              disabled={readOnly}
              className="h-8 text-xs"
              onChange={(e) =>
                set<typeof node>((n) => ({
                  ...n,
                  config: { ...n.config, outcome: (e.target.value || undefined) as typeof n.config.outcome },
                }))
              }
            >
              <option value="">(none)</option>
              {outcomeTags.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Row>
        </>
      )}

      <ExtraFields
        node={node}
        onChange={onChange}
        suggestions={suggestions}
        connectors={connectors}
        sources={sources}
        flows={flows}
        currentFlowId={currentFlowId}
        readOnly={readOnly}
      />
      <OrchestrationFields
        node={node}
        onChange={onChange}
        suggestions={suggestions}
        configuredProviders={configuredProviders}
        readOnly={readOnly}
      />
      <NodeComments
        nodeId={node.id}
        comments={comments}
        onAdd={onAddComment}
        onResolve={onResolveComment}
        canComment={canComment}
      />

      {node.type !== "start" && (
        <details className="rounded-lg border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium text-text">Error handling</summary>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Row label="On error">
              <Select
                value={node.onError ?? "stop"}
                disabled={readOnly}
                className="h-8 text-xs"
                onChange={(e) =>
                  set((n) => ({
                    ...n,
                    onError: e.target.value === "stop" ? undefined : (e.target.value as "continue"),
                  }))
                }
              >
                <option value="stop">Stop the run</option>
                <option value="continue">Continue</option>
              </Select>
            </Row>
            <Row label="Retries">
              <Input
                type="number"
                min={0}
                max={5}
                disabled={readOnly}
                className="h-8 text-xs"
                value={node.retries ?? 0}
                onChange={(e) => set((n) => ({ ...n, retries: Number(e.target.value) || undefined }))}
              />
            </Row>
          </div>
        </details>
      )}
    </div>
  );
}

function IdField({ node, onRename, disabled }: { node: NodeDef; onRename: Props["onRename"]; disabled: boolean }) {
  return (
    <Row label="Id (used in variables)" hint={<span className="font-mono">{`{{${node.id}.…}}`}</span>}>
      <Input
        key={node.id}
        defaultValue={node.id}
        disabled={disabled}
        className="h-8 font-mono text-xs"
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next === node.id) return;
          if (!ID_RE.test(next)) {
            e.target.value = node.id;
            return;
          }
          const error = onRename(node.id, next);
          if (error) {
            alert(error);
            e.target.value = node.id;
          }
        }}
      />
    </Row>
  );
}

function McpToolForm({
  node,
  connectors,
  suggestions,
  readOnly,
  onChange,
}: {
  node: Extract<NodeDef, { type: "mcp_tool" }>;
  connectors: ConnectorSummary[];
  suggestions: { path: string; hint: string }[];
  readOnly: boolean;
  onChange: (n: NodeDef) => void;
}) {
  const connector = connectors.find((c) => c.id === node.config.connectorId);
  const tool = connector?.toolCatalog.find((t) => t.name === node.config.tool);
  const props = (tool?.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  const required = new Set((tool?.inputSchema.required as string[]) ?? []);
  const update = (config: typeof node.config) => onChange({ ...node, config });
  return (
    <>
      <Row label="Connector">
        <Select
          value={node.config.connectorId}
          disabled={readOnly}
          className="h-8 text-xs"
          onChange={(e) => update({ ...node.config, connectorId: e.target.value, tool: "", args: {} })}
        >
          <option value="">Choose a connector…</option>
          {connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Row>
      {connector && (
        <Row label="Tool" hint={tool?.description}>
          <Select
            value={node.config.tool}
            disabled={readOnly}
            className="h-8 text-xs"
            onChange={(e) => update({ ...node.config, tool: e.target.value, args: {} })}
          >
            <option value="">Choose a tool…</option>
            {connector.toolCatalog.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.mode})
              </option>
            ))}
          </Select>
        </Row>
      )}
      {tool &&
        Object.entries(props).map(([key, p]) => (
          <Row key={key} label={`${key}${required.has(key) ? " *" : ""}`} hint={p.description}>
            <FormulaField
              value={node.config.args[key] ?? ""}
              disabled={readOnly}
              suggestions={suggestions}
              placeholder="triage.output.order_id"
              onChange={(v) => {
                const args = { ...node.config.args };
                if (v) args[key] = v;
                else delete args[key];
                update({ ...node.config, args });
              }}
            />
          </Row>
        ))}
    </>
  );
}
