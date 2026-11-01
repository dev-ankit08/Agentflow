import { ensureOk, parseArgs, sseData } from "../sse";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  EmbedResponse,
  LLMProvider,
  ProviderCredentials,
  ProviderId,
} from "../types";

export function toOpenAI(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

type Target = { url: string; embedUrl: string; headers: Record<string, string>; maxTokensField: string };

/** Chat Completions wire format, shared by OpenAI, Azure OpenAI and OpenAI-compatible servers (Ollama, vLLM, …). */
function makeOpenAIProvider(id: ProviderId, target: (creds: ProviderCredentials) => Target): LLMProvider {
  return {
    id,
    async embed(req, creds): Promise<EmbedResponse> {
      const t = target(creds);
      const res = await fetch(t.embedUrl, {
        method: "POST",
        signal: req.signal,
        headers: { "content-type": "application/json", ...t.headers },
        body: JSON.stringify({ model: req.model, input: req.input }),
      });
      await ensureOk(res, id === "azure_openai" ? "Azure OpenAI" : "OpenAI");
      const body = (await res.json()) as {
        data: { index: number; embedding: number[] }[];
        usage?: { prompt_tokens?: number };
      };
      const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return { vectors, usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: 0 } };
    },
    async chat(req: ChatRequest, creds, onToken) {
      const t = target(creds);
      const res = await fetch(t.url, {
        method: "POST",
        signal: req.signal,
        headers: { "content-type": "application/json", ...t.headers },
        body: JSON.stringify({
          model: req.model,
          messages: toOpenAI(req.messages),
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.maxTokens !== undefined && { [t.maxTokensField]: req.maxTokens }),
          ...(req.tools?.length && {
            tools: req.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema },
            })),
          }),
          ...(req.jsonMode && !req.tools?.length && { response_format: { type: "json_object" } }),
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      await ensureOk(res, id === "azure_openai" ? "Azure OpenAI" : "OpenAI");

      const result: ChatResponse = {
        text: "",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: null,
      };
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const data of sseData(res)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data);
        if (chunk.usage) {
          result.usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          result.text += delta.content;
          onToken?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const entry = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          calls.set(tc.index, entry);
        }
        if (choice.finish_reason) result.stopReason = choice.finish_reason;
      }
      result.toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseArgs(c.args) }));
      return result;
    },
  };
}

const trim = (url: string) => url.replace(/\/+$/, "");

export const openai = makeOpenAIProvider("openai", (creds) => ({
  url: `${trim(creds.baseUrl || "https://api.openai.com/v1")}/chat/completions`,
  embedUrl: `${trim(creds.baseUrl || "https://api.openai.com/v1")}/embeddings`,
  headers: { authorization: `Bearer ${creds.apiKey}` },
  maxTokensField: "max_completion_tokens",
}));

export const openaiCompatible = makeOpenAIProvider("openai_compatible", (creds) => ({
  url: `${trim(creds.baseUrl || "http://localhost:11434/v1")}/chat/completions`,
  embedUrl: `${trim(creds.baseUrl || "http://localhost:11434/v1")}/embeddings`,
  headers: creds.apiKey ? { authorization: `Bearer ${creds.apiKey}` } : ({} as Record<string, string>),
  maxTokensField: "max_tokens",
}));

/**
 * Azure OpenAI. Accepts either the resource URL (uses the v1 API, model = deployment name)
 * or a full deployment URL (…/openai/deployments/<name>) with the classic api-version query.
 */
export const azureOpenAI = makeOpenAIProvider("azure_openai", (creds) => {
  const base = trim(creds.baseUrl ?? "");
  const deployment = base.includes("/openai/deployments/");
  const root = `${base.replace(/\/openai(\/v1)?$/, "")}/openai/v1`;
  return {
    url: deployment ? `${base}/chat/completions?api-version=2024-10-21` : `${root}/chat/completions`,
    embedUrl: deployment ? `${base}/embeddings?api-version=2024-10-21` : `${root}/embeddings`,
    headers: { "api-key": creds.apiKey },
    maxTokensField: "max_completion_tokens",
  };
});
