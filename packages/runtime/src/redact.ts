/** PII redaction applied before prompts are stored in traces (docs/07-security-and-compliance.md §3). */
const patterns: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<EMAIL>"],
  [/\b(?:\d[ -]?){13,19}\b/g, "<CARD_OR_ACCOUNT>"],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "<AADHAAR>"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "<PAN>"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "<SSN>"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "<IBAN>"],
  // 8+ digits in phone-like groups: "+91 98765 43210", "(555) 123-4567". Short ids like order numbers are kept.
  [/(?<![\w+])(?:\+\d{1,3}[\s.-]?)?\(?\d{2,5}\)?[\s.-]?\d{3,5}[\s.-]?\d{3,5}\b/g, "<PHONE>"],
];

export function redactPII(text: string): string {
  return patterns.reduce((t, [re, label]) => t.replace(re, label), text);
}

export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactPII(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}
