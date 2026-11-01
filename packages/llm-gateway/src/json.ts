type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
};

/** Validates the subset of JSON Schema used for agent output schemas. Returns an error message or null. */
export function validateJson(value: unknown, schema: Schema, path = "$"): string | null {
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length) {
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return `${path} must be ${types.join(" or ")}`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) {
        const err = validateJson(obj[key], sub, `${path}.${key}`);
        if (err) return err;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validateJson(value[i], schema.items, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/** Extracts a JSON value from model text, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Response is not JSON");
  }
}
