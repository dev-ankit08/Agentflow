import { renderContextRules, renderTemplate, type ContextRuleTrace, type Scope } from "@agentflow/expression-engine";

const CONTEXT_SLOT = /\{\{\s*context\s*\}\}/;

/**
 * Builds an AI step's system prompt with its context rules applied: only the matching blocks are included, at
 * {{context}} if the prompt has it, otherwise in a "Context" section at the end. Returns the trace of which rules
 * matched, for the step's output (undefined when the step has no rules).
 */
export function withContext(
  systemTemplate: string,
  rules: string | undefined,
  scope: Scope,
): { system: string; trace?: ContextRuleTrace[] } {
  if (!rules?.trim()) return { system: renderTemplate(systemTemplate, scope) };
  const { text, trace } = renderContextRules(rules, scope);
  if (CONTEXT_SLOT.test(systemTemplate))
    return { system: renderTemplate(systemTemplate, { ...scope, context: text }), trace };
  const system = renderTemplate(systemTemplate, scope);
  return { system: text ? `${system}\n\n## Context\n${text}` : system, trace };
}
