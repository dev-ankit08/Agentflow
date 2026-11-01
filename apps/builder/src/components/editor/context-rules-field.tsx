"use client";

import { useMemo, useState } from "react";
import { checkContextRules, parseContextRules, renderContextRules } from "@agentflow/expression-engine";
import { Button } from "@agentflow/ui";

const EXAMPLE = `# Context rules: evaluated top to bottom from variables, no AI involved.
# Only matching blocks are sent, at {{context}} in the prompt or in a "Context" section at the end.
- when: user.plan == "vip"
  include: The customer is VIP. Offer free express shipping.
  else: Standard customer.

- switch: lookup.result.status
  cases:
    shipped: "Share the delivery estimate: {{lookup.result.eta}}"
    processing: Say it ships within 2 days.
  default: Ask for the order number if it's missing.

- first:   # else-if: the first rule that applies
    - when: lookup.result.total > 1000
      include: High-value order; be extra careful.
    - include: Standard order.
`;

const HELP: [string, string][] = [
  ["when / include / else", "if a formula is true, include the text; otherwise the else text (optional)"],
  ["switch / cases / default", "pick the text for a value, e.g. an order status"],
  ["first", "a list of rules; only the first that applies is used (else-if)"],
  ["include on its own", "always included; add title for a heading"],
  ["id", "names the rule in run traces"],
];

/** Builds sample values shaped like the variables available at this step, e.g. { user: { plan: "" } }. */
function skeleton(paths: string[]) {
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    const parts = path.split(".");
    let node = root;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) {
        if (!(p in node)) node[p] = "";
      } else {
        if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
        node = node[p] as Record<string, unknown>;
      }
    });
  }
  return JSON.stringify(root, null, 2);
}

/** YAML context rules for an AI step: live checking, an example, and a preview against sample values. */
export function ContextRulesField({
  value,
  onChange,
  suggestions,
  disabled,
}: {
  value: string;
  onChange: (value: string | undefined) => void;
  suggestions: { path: string; hint: string }[];
  disabled?: boolean;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [sample, setSample] = useState(() => skeleton(suggestions.map((s) => s.path)));
  const issues = useMemo(() => checkContextRules(value), [value]);
  const ruleCount = useMemo(() => parseContextRules(value).rules.length, [value]);

  let sampleError: string | null = null;
  let scope: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(sample || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) scope = parsed;
    else sampleError = "Sample values must be a JSON object";
  } catch {
    sampleError = "Sample values are not valid JSON yet";
  }
  const preview = showPreview && !issues.length ? renderContextRules(value, scope) : null;

  return (
    <details className="rounded-lg border border-border p-2" open={Boolean(value.trim())}>
      <summary className="cursor-pointer text-xs font-medium text-text">
        Context rules (YAML){ruleCount ? <span className="ml-1 text-muted">· {ruleCount} rules</span> : null}
        {issues.length ? <span className="ml-1 text-danger">· {issues.length} issue(s)</span> : null}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-[11px] text-muted">
          Decide from variables which context this AI step receives. Only matching blocks are sent, at{" "}
          <code className="font-mono">{"{{context}}"}</code> in the prompt or at its end.
        </p>
        <textarea
          value={value}
          disabled={disabled}
          rows={Math.min(18, Math.max(6, value.split("\n").length + 1))}
          spellCheck={false}
          aria-label="Context rules in YAML"
          placeholder={'- when: user.plan == "vip"\n  include: The customer is VIP.'}
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value : undefined)}
          className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text focus:border-accent focus:outline-none"
        />
        {issues.length > 0 && (
          <ul className="space-y-0.5 rounded-md bg-danger/10 p-2">
            {issues.slice(0, 8).map((issue, i) => (
              <li key={i} className="font-mono text-[11px] text-danger">
                line {issue.line}: {issue.message}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 text-[11px]">
          {!disabled && !value.trim() && (
            <Button size="sm" variant="secondary" onClick={() => onChange(EXAMPLE)}>
              Insert example
            </Button>
          )}
          <button type="button" className="text-accent hover:underline" onClick={() => setShowHelp((s) => !s)}>
            {showHelp ? "Hide syntax" : "Syntax"}
          </button>
          {value.trim() && (
            <button type="button" className="text-accent hover:underline" onClick={() => setShowPreview((s) => !s)}>
              {showPreview ? "Hide preview" : "Preview with sample values"}
            </button>
          )}
        </div>
        {showHelp && (
          <dl className="space-y-1 rounded-md bg-surface-2 p-2 text-[11px]">
            {HELP.map(([k, v]) => (
              <div key={k}>
                <dt className="inline font-mono text-text">{k}</dt>
                <dd className="inline text-muted"> — {v}</dd>
              </div>
            ))}
            <p className="pt-1 text-muted">
              Conditions are formulas (
              <code className="font-mono">order.total {">"} 500 AND user.plan == &quot;vip&quot;</code>
              ); texts can use <code className="font-mono">{"{{variables}}"}</code>.
            </p>
          </dl>
        )}
        {showPreview && (
          <div className="space-y-2 rounded-md border border-dashed border-border p-2">
            <label className="block text-[11px] font-medium text-muted">
              Sample values (JSON)
              <textarea
                value={sample}
                rows={6}
                spellCheck={false}
                onChange={(e) => setSample(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
              />
            </label>
            {sampleError && <p className="text-[11px] text-warning">{sampleError}</p>}
            {issues.length > 0 && <p className="text-[11px] text-warning">Fix the issues above to preview.</p>}
            {preview && (
              <>
                <p className="text-[11px] font-medium text-muted">The agent receives:</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-[11px] text-text">
                  {preview.text || "(no context: no rule matched)"}
                </pre>
                <ul className="space-y-0.5 text-[11px]">
                  {preview.trace.map((t, i) => (
                    <li key={i} className={t.matched ? "text-success" : "text-muted"}>
                      {t.matched ? "✓" : "✗"} rule {t.rule}
                      {t.branch ? ` → ${t.branch}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
