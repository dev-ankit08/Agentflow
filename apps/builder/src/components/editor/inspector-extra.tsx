"use client";

import { approverRoles, formFieldTypes, type NodeDef } from "@agentflow/flow-schema";
import { Button, Input, Select } from "@agentflow/ui";
import { FormulaField, ListInput, Row, TemplateField, HowItWorks } from "./fields";
import type { ConnectorSummary } from "./model";

export type SourceSummary = { id: string; name: string };
export type FlowSummary = { id: string; name: string; liveVersionId: string | null };

type Props = {
  node: NodeDef;
  onChange: (node: NodeDef) => void;
  suggestions: { path: string; hint: string }[];
  connectors: ConnectorSummary[];
  sources: SourceSummary[];
  flows: FlowSummary[];
  currentFlowId: string;
  readOnly: boolean;
};

/** Settings for Knowledge, Approval, Handoff, Guardrail, Subflow and Form nodes. */
export function ExtraFields({
  node,
  onChange,
  suggestions,
  connectors,
  sources,
  flows,
  currentFlowId,
  readOnly,
}: Props) {
  switch (node.type) {
    case "knowledge": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      return (
        <>
          <Row label="Search for" hint="A formula; usually the user's message.">
            <FormulaField
              value={node.config.query}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(query) => set({ query })}
            />
          </Row>
          <Row label="Sources" hint={sources.length ? "Leave all unticked to search every source." : undefined}>
            {sources.length === 0 ? (
              <p className="text-[11px] text-muted">Add documents or web pages on the Knowledge page first.</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {sources.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5 text-[11px] text-text">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={node.config.sources.includes(s.id)}
                      onChange={(e) =>
                        set({
                          sources: e.target.checked
                            ? [...node.config.sources, s.id]
                            : node.config.sources.filter((x) => x !== s.id),
                        })
                      }
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
          </Row>
          <Row label="Passages to retrieve">
            <Input
              type="number"
              min={1}
              max={10}
              disabled={readOnly}
              className="h-8 text-xs"
              value={node.config.topK}
              onChange={(e) =>
                set({ topK: Math.min(10, Math.max(1, e.target.value === "" ? 4 : Number(e.target.value))) })
              }
            />
          </Row>
          <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
            Put <code className="font-mono">{`{{${node.id}.context}}`}</code> in an agent&apos;s system prompt and tell
            it to answer only from those passages. Replies list the sources as citations.
          </p>
        </>
      );
    }

    case "approval": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      return (
        <>
          <Row label="Request shown to the approver">
            <TemplateField
              value={node.config.message}
              rows={3}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(message) => set({ message })}
            />
          </Row>
          <Row label="Reply to the user while waiting">
            <TemplateField
              value={node.config.pendingMessage}
              rows={2}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(pendingMessage) => set({ pendingMessage })}
            />
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Who can approve">
              <Select
                value={node.config.approverRole}
                disabled={readOnly}
                className="h-8 text-xs"
                onChange={(e) => set({ approverRole: e.target.value as typeof node.config.approverRole })}
              >
                {approverRoles.map((r) => (
                  <option key={r} value={r}>
                    {r} or higher
                  </option>
                ))}
              </Select>
            </Row>
            <Row label="Timeout (minutes)">
              <Input
                type="number"
                min={1}
                disabled={readOnly}
                className="h-8 text-xs"
                value={node.config.timeoutMinutes}
                onChange={(e) =>
                  set({ timeoutMinutes: Math.max(1, e.target.value === "" ? 1440 : Number(e.target.value)) })
                }
              />
            </Row>
          </div>
          <HowItWorks>Requests appear in the Inbox. Connect the approved, rejected and timeout outcomes.</HowItWorks>
        </>
      );
    }

    case "handoff": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      const connector = connectors.find((c) => c.id === node.config.connectorId);
      return (
        <>
          <Row label="Team queue">
            <Input
              value={node.config.queue}
              disabled={readOnly}
              className="h-8 text-xs"
              onChange={(e) => set({ queue: e.target.value })}
            />
          </Row>
          <Row label="Reply to the user">
            <TemplateField
              value={node.config.message}
              rows={2}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(message) => set({ message })}
            />
          </Row>
          <Row
            label="Also open a ticket with (optional)"
            hint="The tool receives summary, transcript and queue (when its schema accepts them)."
          >
            <div className="grid grid-cols-2 gap-1">
              <Select
                value={node.config.connectorId ?? ""}
                disabled={readOnly}
                className="h-8 text-xs"
                onChange={(e) => set({ connectorId: e.target.value || undefined, tool: undefined })}
              >
                <option value="">No ticket</option>
                {connectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              {connector && (
                <Select
                  value={node.config.tool ?? ""}
                  disabled={readOnly}
                  className="h-8 text-xs"
                  onChange={(e) => set({ tool: e.target.value || undefined })}
                >
                  <option value="">Choose a tool…</option>
                  {connector.toolCatalog.map((t) => (
                    <option key={t.name}>{t.name}</option>
                  ))}
                </Select>
              )}
            </div>
          </Row>
          <HowItWorks>
            Handoffs appear in the Inbox with the transcript and a summary of the customer&apos;s messages.
          </HowItWorks>
        </>
      );
    }

    case "guardrail": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      const checks = node.config.checks;
      const setChecks = (c: Partial<typeof checks>) => set({ checks: { ...checks, ...c } });
      return (
        <>
          <Row label="Text to check">
            <TemplateField
              value={node.config.input}
              rows={2}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(input) => set({ input })}
            />
          </Row>
          <div className="space-y-1.5 rounded-lg border border-border p-2 text-xs text-text">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={checks.pii}
                onChange={(e) => setChecks({ pii: e.target.checked })}
              />
              Personal data (emails, phone and card numbers, IDs)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={checks.injection}
                onChange={(e) => setChecks({ injection: e.target.checked })}
              />
              Prompt-injection attempts
            </label>
          </div>
          <Row label="Blocked topics (comma-separated)">
            <ListInput
              value={checks.blockedTopics}
              disabled={readOnly}
              placeholder="legal advice, competitors"
              className="h-8 text-xs"
              onChange={(blockedTopics) => setChecks({ blockedTopics })}
            />
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Max length">
              <Input
                type="number"
                min={1}
                disabled={readOnly}
                className="h-8 text-xs"
                value={checks.maxLength ?? ""}
                placeholder="none"
                onChange={(e) => setChecks({ maxLength: e.target.value ? Number(e.target.value) : undefined })}
              />
            </Row>
            <Row label="Personal data">
              <Select
                value={node.config.action}
                disabled={readOnly}
                className="h-8 text-xs"
                onChange={(e) => set({ action: e.target.value as "block" | "redact" })}
              >
                <option value="block">Block (fail)</option>
                <option value="redact">Mask and continue</option>
              </Select>
            </Row>
          </div>
          <HowItWorks>
            Connect the pass and fail outcomes. The checked text is available as{" "}
            <code className="font-mono">{`{{${node.id}.text}}`}</code>.
          </HowItWorks>
        </>
      );
    }

    case "subflow": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      const entries = Object.entries(node.config.inputs);
      return (
        <>
          <Row label="Flow to run">
            <Select
              value={node.config.flowId}
              disabled={readOnly}
              className="h-8 text-xs"
              onChange={(e) => set({ flowId: e.target.value })}
            >
              <option value="">Choose a flow…</option>
              {flows
                .filter((f) => f.id !== currentFlowId)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.liveVersionId ? "" : " (not published)"}
                  </option>
                ))}
            </Select>
          </Row>
          <label className="flex items-center gap-2 text-xs text-text">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={node.config.useDraft}
              onChange={(e) => set({ useDraft: e.target.checked })}
            />
            Use its draft instead of the live version
          </label>
          <Row label="Inputs (available as {{trigger.name}} in the subflow)">
            <div className="space-y-1.5">
              {entries.map(([key, value], i) => (
                <div key={i} className="grid grid-cols-[90px_1fr_auto] items-start gap-1">
                  <Input
                    value={key}
                    disabled={readOnly}
                    className="h-8 font-mono text-xs"
                    onChange={(e) => {
                      const name = e.target.value.replace(/[^a-zA-Z0-9_]/g, "");
                      set({ inputs: Object.fromEntries(entries.map(([k, v], j) => (j === i ? [name, v] : [k, v]))) });
                    }}
                  />
                  <FormulaField
                    value={value}
                    disabled={readOnly}
                    suggestions={suggestions}
                    onChange={(v) => set({ inputs: { ...node.config.inputs, [key]: v } })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={readOnly}
                    aria-label="Remove input"
                    onClick={() => set({ inputs: Object.fromEntries(entries.filter((_, j) => j !== i)) })}
                  >
                    ×
                  </Button>
                </div>
              ))}
              {!readOnly && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    set({ inputs: { ...node.config.inputs, [`input${entries.length + 1}`]: "trigger.message" } })
                  }
                >
                  + Add input
                </Button>
              )}
            </div>
          </Row>
          <HowItWorks>
            The subflow&apos;s End output fields become <code className="font-mono">{`{{${node.id}.field}}`}</code>.
          </HowItWorks>
        </>
      );
    }

    case "form": {
      const set = (config: Partial<typeof node.config>) => onChange({ ...node, config: { ...node.config, ...config } });
      const fields = node.config.fields;
      const setField = (i: number, patch: Partial<(typeof fields)[number]>) =>
        set({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
      return (
        <>
          <Row label="Title">
            <TemplateField
              value={node.config.title}
              rows={2}
              disabled={readOnly}
              suggestions={suggestions}
              onChange={(title) => set({ title })}
            />
          </Row>
          {fields.map((f, i) => (
            <div key={i} className="space-y-1 rounded-lg border border-border p-2">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-1">
                <Input
                  value={f.label}
                  aria-label="Field label"
                  disabled={readOnly}
                  className="h-8 text-xs"
                  onChange={(e) => setField(i, { label: e.target.value })}
                />
                <Input
                  value={f.name}
                  aria-label="Field name"
                  disabled={readOnly}
                  className="h-8 font-mono text-xs"
                  onChange={(e) => setField(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readOnly || fields.length === 1}
                  aria-label="Remove field"
                  onClick={() => set({ fields: fields.filter((_, j) => j !== i) })}
                >
                  ×
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={f.type}
                  disabled={readOnly}
                  className="h-7 w-28 text-[11px]"
                  onChange={(e) => setField(i, { type: e.target.value as (typeof formFieldTypes)[number] })}
                >
                  {formFieldTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
                <label className="flex items-center gap-1 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={f.required}
                    onChange={(e) => setField(i, { required: e.target.checked })}
                  />
                  Required
                </label>
              </div>
              {f.type === "select" && (
                <ListInput
                  value={f.options ?? []}
                  placeholder="Options, comma-separated"
                  disabled={readOnly}
                  className="h-7 text-[11px]"
                  onChange={(options) => setField(i, { options })}
                />
              )}
            </div>
          ))}
          {!readOnly && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                set({
                  fields: [
                    ...fields,
                    { name: `field${fields.length + 1}`, label: "New field", type: "text", required: false },
                  ],
                })
              }
            >
              + Add field
            </Button>
          )}
          <Row label="Button label">
            <Input
              value={node.config.submitLabel}
              disabled={readOnly}
              className="h-8 text-xs"
              onChange={(e) => set({ submitLabel: e.target.value })}
            />
          </Row>
        </>
      );
    }

    default:
      return null;
  }
}
