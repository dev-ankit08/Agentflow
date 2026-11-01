"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { checkFormula, checkTemplate } from "@agentflow/expression-engine";
import { providers, type ModelRef } from "@agentflow/flow-schema";
import { Button, InfoTip, Input, Label, Select, cn } from "@agentflow/ui";
import { modelSuggestions, providerLabels } from "./model";

/** A comma-separated list field that keeps what you type (commas, spaces) while updating the parsed list. */
export function ListInput({
  value,
  onChange,
  placeholder,
  disabled,
  className,
}: {
  value: string[];
  onChange: (list: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const parse = (t: string) =>
    t
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const [text, setText] = useState(value.join(", "));
  // Follow outside changes (undo, a collaborator) without fighting the user's typing.
  const shown = parse(text).join("\u0000") === value.join("\u0000") ? text : value.join(", ");
  return (
    <Input
      value={shown}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}

/** A labelled field: `hint` explains it in a tooltip; `note` stays visible under it (warnings, live feedback). */
export function Row({
  label,
  hint,
  note,
  children,
}: {
  label: string;
  hint?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label className="mb-0 text-xs font-medium text-muted">{label}</Label>
        {hint && <InfoTip label={`About ${label}`}>{hint}</InfoTip>}
      </div>
      {children}
      {note && <p className="text-[11px] text-muted">{note}</p>}
    </div>
  );
}

/** A one-line "How it works" with the explanation in a tooltip, for help that has no field to sit next to. */
export function HowItWorks({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted">
      <InfoTip label="How it works">{children}</InfoTip>
      <span>How it works</span>
    </div>
  );
}

/** A collapsible group of settings; the summary shows a short status (e.g. "2 selected") when closed. */
export function Section({
  title,
  hint,
  status,
  defaultOpen,
  children,
}: {
  title: string;
  hint?: ReactNode;
  status?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-border p-2" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-text [&::-webkit-details-marker]:hidden">
        <span className="text-muted transition group-open:rotate-90">▸</span>
        {title}
        {status && <span className="font-normal text-muted">· {status}</span>}
        {hint && (
          <span onClick={(e) => e.preventDefault()} className="inline-flex">
            <InfoTip label={`About ${title}`}>{hint}</InfoTip>
          </span>
        )}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

type Suggestion = { path: string; hint: string };

/** Prompt/message editor: `{{variable}}` chips insert at the cursor; block structure is checked live. */
export function TemplateField({
  value,
  onChange,
  suggestions,
  rows = 4,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: Suggestion[];
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [showVars, setShowVars] = useState(false);
  const issues = checkTemplate(value);
  const insert = (path: string) => {
    const el = ref.current;
    const token = `{{${path}}}`;
    if (!el) return onChange(value + token);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div>
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full rounded-lg border bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-text focus:outline-none focus:ring-2 focus:ring-accent/30",
          issues.length ? "border-danger" : "border-border focus:border-accent",
        )}
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <button
          type="button"
          className="text-[11px] text-accent hover:underline"
          onClick={() => setShowVars((s) => !s)}
          disabled={disabled}
        >
          {showVars ? "Hide variables" : "{{ Insert variable }}"}
        </button>
        <InfoTip label="Template syntax">
          <span className="font-mono">{"{{variable}}"}</span> inserts a value.{" "}
          <span className="font-mono">{"{{#if cond}} … {{else}} … {{/if}}"}</span> adds text only when a condition
          holds.
        </InfoTip>
      </div>
      {showVars && (
        <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto rounded-lg bg-surface-2 p-2">
          {suggestions.map((s) => (
            <button
              key={s.path}
              type="button"
              title={s.hint}
              onClick={() => insert(s.path)}
              className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text hover:border-accent"
            >
              {s.path}
            </button>
          ))}
        </div>
      )}
      {issues.map((i, k) => (
        <p key={k} className="mt-1 text-[11px] text-danger">
          {i.message}
        </p>
      ))}
    </div>
  );
}

/** Formula input (no braces), checked as you type. */
export function FormulaField({
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: Suggestion[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const issue = value.trim() ? checkFormula(value) : { message: "Required", position: 0 };
  const listId = useId();
  return (
    <div>
      <div className="flex items-center gap-1">
        <span className="font-mono text-[11px] text-muted" aria-hidden>
          fx
        </span>
        <Input
          value={value}
          list={listId}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn("h-8 font-mono text-xs", issue && "border-danger")}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s.path} value={s.path}>
              {s.hint}
            </option>
          ))}
        </datalist>
      </div>
      {issue && <p className="mt-1 text-[11px] text-danger">{issue.message}</p>}
    </div>
  );
}

type SchemaField = { name: string; type: string; enumValues: string; required: boolean };

function schemaToFields(schema: Record<string, unknown> | undefined): SchemaField[] {
  const props = (schema?.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const required = new Set((schema?.required as string[]) ?? []);
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: p.type ?? "string",
    enumValues: (p.enum ?? []).join(", "),
    required: required.has(name),
  }));
}

function fieldsToSchema(fields: SchemaField[]): Record<string, unknown> | undefined {
  const valid = fields.filter((f) => f.name.trim());
  if (valid.length === 0) return undefined;
  return {
    type: "object",
    properties: Object.fromEntries(
      valid.map((f) => {
        const values = f.enumValues
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        return [f.name.trim(), { type: f.type, ...(values.length && f.type === "string" ? { enum: values } : {}) }];
      }),
    ),
    required: valid.filter((f) => f.required).map((f) => f.name.trim()),
  };
}

/** Visual builder for an agent's structured output; each field becomes `{{node.output.field}}`. */
export function SchemaBuilder({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (v: Record<string, unknown> | undefined) => void;
  disabled?: boolean;
}) {
  const fields = schemaToFields(value);
  const update = (next: SchemaField[]) => onChange(fieldsToSchema(next));
  return (
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={i} className="rounded-lg border border-border p-2">
          <div className="flex gap-1">
            <Input
              value={f.name}
              aria-label="Field name"
              placeholder="field"
              disabled={disabled}
              className="h-8 font-mono text-xs"
              onChange={(e) =>
                update(
                  fields.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") } : x)),
                )
              }
            />
            <Select
              value={f.type}
              aria-label="Field type"
              disabled={disabled}
              className="h-8 w-24 text-xs"
              onChange={(e) => update(fields.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
            >
              {["string", "number", "integer", "boolean"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Remove field"
              disabled={disabled}
              onClick={() => update(fields.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </div>
          {f.type === "string" && (
            <Input
              value={f.enumValues}
              placeholder="Allowed values, comma-separated (optional)"
              disabled={disabled}
              className="mt-1 h-7 text-[11px]"
              onChange={(e) => update(fields.map((x, j) => (j === i ? { ...x, enumValues: e.target.value } : x)))}
            />
          )}
          <label className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={f.required}
              disabled={disabled}
              onChange={(e) => update(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
            />
            Required
          </label>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() =>
          update([...fields, { name: `field${fields.length + 1}`, type: "string", enumValues: "", required: false }])
        }
      >
        + Add output field
      </Button>
    </div>
  );
}

/** Provider and model name, warning when the workspace has no key for the provider. */
export function ModelPicker({
  value,
  onChange,
  configured,
  disabled,
  label,
}: {
  value: ModelRef;
  onChange: (m: ModelRef) => void;
  configured: string[];
  disabled: boolean;
  label: string;
}) {
  const missing = !configured.includes(value.provider);
  return (
    <Row
      label={label}
      note={
        missing ? <span className="text-warning">No key for this provider yet — add one in Settings.</span> : undefined
      }
    >
      <div className="grid grid-cols-2 gap-1">
        <Select
          value={value.provider}
          disabled={disabled}
          className="h-8 text-xs"
          aria-label="Provider"
          onChange={(e) => {
            const provider = e.target.value as ModelRef["provider"];
            onChange({ provider, name: modelSuggestions[provider][0] ?? "" });
          }}
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {providerLabels[p]}
              {configured.includes(p) ? " ✓" : ""}
            </option>
          ))}
        </Select>
        <Input
          value={value.name}
          disabled={disabled}
          list={`models-${value.provider}`}
          aria-label="Model name"
          className="h-8 font-mono text-xs"
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
        <datalist id={`models-${value.provider}`}>
          {modelSuggestions[value.provider].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
    </Row>
  );
}
