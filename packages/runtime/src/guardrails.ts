import { redactPII } from "./redact";

/** Phrases typical of prompt-injection attempts (docs/07-security-and-compliance.md, LLM01). */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|messages|rules)/i,
  /disregard (all |any )?(previous|prior|above|your) (instructions|rules|guidelines)/i,
  /(reveal|show|print|repeat) (me )?(your|the) (system prompt|instructions|hidden prompt)/i,
  /you are now (a |an )?(?!customer)/i,
  /\b(jailbreak|DAN mode|developer mode)\b/i,
  /<\/?(system|assistant)>/i,
  /act as (if you are |an? )?(unrestricted|unfiltered)/i,
];

export type GuardrailChecks = { pii: boolean; injection: boolean; blockedTopics: string[]; maxLength?: number };
export type GuardrailResult = { passed: boolean; violations: string[]; text: string };

/**
 * Checks text against the configured rules. With "redact", personal data is masked and does not count as a
 * violation; every other rule still fails the check.
 */
export function runGuardrail(text: string, checks: GuardrailChecks, action: "block" | "redact"): GuardrailResult {
  const violations: string[] = [];
  let output = text;
  if (checks.pii) {
    const redacted = redactPII(text);
    if (redacted !== text) {
      if (action === "redact") output = redacted;
      else violations.push("personal data");
    }
  }
  if (checks.injection && INJECTION_PATTERNS.some((p) => p.test(text))) violations.push("prompt injection");
  const lower = text.toLowerCase();
  for (const topic of checks.blockedTopics) {
    const t = topic.trim().toLowerCase();
    if (t && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) {
      violations.push(`blocked topic: ${topic}`);
    }
  }
  if (checks.maxLength && text.length > checks.maxLength) violations.push(`longer than ${checks.maxLength} characters`);
  return { passed: violations.length === 0, violations, text: output };
}

/** Marks content from tools or documents as data, so the model does not treat it as instructions. */
export function untrusted(source: string, content: string): string {
  return `<untrusted_data source="${source}">\n${content.replaceAll("</untrusted_data>", "")}\n</untrusted_data>`;
}
