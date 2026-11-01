import { signRequest } from "../sigv4";
import { ensureOk } from "../sse";
import {
  ProviderError,
  type ChatMessage,
  type ChatResponse,
  type LLMProvider,
  type ProviderCredentials,
} from "../types";

type Content =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: { text: string }[] } };

/** Converts chat messages to the Bedrock Converse format (system separate; tool results are user turns). */
export function toConverse(messages: ChatMessage[]) {
  const system = messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
  const out: { role: "user" | "assistant"; content: Content[] }[] = [];
  const push = (role: "user" | "assistant", content: Content[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ text: m.content }]);
    else if (m.role === "assistant") {
      const content: Content[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls ?? [])
        content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments } });
      if (content.length) push("assistant", content);
    } else if (m.role === "tool") {
      push("user", [{ toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }] } }]);
    }
  }
  return { system, messages: out };
}

/**
 * Credentials: either a Bedrock API key (sent as a bearer token), or IAM keys as
 * "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]". The base URL is the region (e.g. us-east-1) or a full endpoint.
 */
export function bedrockTarget(creds: ProviderCredentials) {
  const base = (creds.baseUrl ?? "us-east-1").trim();
  const endpoint = base.startsWith("http") ? base.replace(/\/+$/, "") : `https://bedrock-runtime.${base}.amazonaws.com`;
  const region = base.startsWith("http") ? (/bedrock-runtime\.([a-z0-9-]+)\./.exec(base)?.[1] ?? "us-east-1") : base;
  const parts = creds.apiKey.split(":");
  const iam = parts.length >= 2 && /^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(parts[0]!);
  return {
    endpoint,
    region,
    iam: iam
      ? { accessKeyId: parts[0]!, secretAccessKey: parts[1]!, sessionToken: parts.slice(2).join(":") || undefined }
      : null,
  };
}

/** AWS Bedrock via the Converse API (non-streaming: the full reply arrives as one token). */
export const bedrock: LLMProvider = {
  id: "bedrock",
  async chat(req, creds, onToken) {
    const target = bedrockTarget(creds);
    const { system, messages } = toConverse(req.messages);
    const body = JSON.stringify({
      messages,
      ...(system.length && { system }),
      inferenceConfig: {
        ...(req.maxTokens !== undefined && { maxTokens: req.maxTokens }),
        ...(req.temperature !== undefined && { temperature: req.temperature }),
      },
      ...(req.tools?.length && {
        toolConfig: {
          tools: req.tools.map((t) => ({
            toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.inputSchema } },
          })),
        },
      }),
    });
    const url = `${target.endpoint}/model/${encodeURIComponent(req.model)}/converse`;
    const baseHeaders = { "content-type": "application/json", accept: "application/json" };
    const headers = target.iam
      ? signRequest({ method: "POST", url, headers: baseHeaders, body }, target.iam, target.region, "bedrock")
      : { ...baseHeaders, authorization: `Bearer ${creds.apiKey}` };

    const res = await fetch(url, { method: "POST", headers, body, signal: req.signal });
    await ensureOk(res, "AWS Bedrock");
    const data = (await res.json()) as {
      output?: {
        message?: {
          content?: { text?: string; toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> } }[];
        };
      };
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    const content = data.output?.message?.content;
    if (!content) throw new ProviderError("AWS Bedrock returned no message");
    const result: ChatResponse = {
      text: content.map((c) => c.text ?? "").join(""),
      toolCalls: content
        .filter((c) => c.toolUse)
        .map((c) => ({ id: c.toolUse!.toolUseId, name: c.toolUse!.name, arguments: c.toolUse!.input ?? {} })),
      usage: { inputTokens: data.usage?.inputTokens ?? 0, outputTokens: data.usage?.outputTokens ?? 0 },
      stopReason: data.stopReason ?? null,
    };
    if (result.text) onToken?.(result.text);
    return result;
  },
};
