import { ProviderError } from "./types";

/** Yields the `data:` payload of each server-sent event in a fetch response body. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new ProviderError("Empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
    if (done) break;
  }
}

/** Throws a ProviderError with the provider's message for non-2xx responses. */
export async function ensureOk(res: Response, provider: string) {
  if (res.ok) return;
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    detail = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? detail;
  } catch {
    // Body was not JSON.
  }
  const retryable = res.status === 429 || res.status >= 500;
  throw new ProviderError(`${provider} error ${res.status}: ${detail}`, res.status, retryable);
}

export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    throw new ProviderError("Model returned invalid tool arguments");
  }
}
