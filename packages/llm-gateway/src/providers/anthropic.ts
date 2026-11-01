import { ensureOk, parseArgs, sseData } from "../sse";
import type { ChatMessage, ChatResponse, LLMProvider, ToolCall } from "../types";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Converts chat messages to Anthropic Messages API format (system separate, tool results as user turns). */
export function toAnthropic(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    else if (m.role === "assistant") {
      const blocks: Block[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      if (blocks.length) push("assistant", blocks);
    } else if (m.role === "tool")
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
  }
  return { system, messages: out };
}

export const anthropic: LLMProvider = {
  id: "anthropic",
  async chat(req, creds, onToken) {
    const { system, messages } = toAnthropic(req.messages);
    const res = await fetch(`${(creds.baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": creds.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        ...(system && { system }),
        messages,
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.tools?.length && {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            input_schema: t.inputSchema,
          })),
        }),
        stream: true,
      }),
    });
    await ensureOk(res, "Anthropic");

    const result: ChatResponse = {
      text: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: null,
    };
    const pending = new Map<number, { id: string; name: string; json: string }>();
    for await (const data of sseData(res)) {
      const ev = JSON.parse(data);
      switch (ev.type) {
        case "message_start":
          result.usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          if (ev.content_block?.type === "tool_use") {
            pending.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
          }
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") {
            result.text += ev.delta.text;
            onToken?.(ev.delta.text);
          } else if (ev.delta?.type === "input_json_delta") {
            const p = pending.get(ev.index);
            if (p) p.json += ev.delta.partial_json;
          }
          break;
        case "content_block_stop": {
          const p = pending.get(ev.index);
          if (p) {
            result.toolCalls.push({ id: p.id, name: p.name, arguments: parseArgs(p.json) } satisfies ToolCall);
            pending.delete(ev.index);
          }
          break;
        }
        case "message_delta":
          result.usage.outputTokens = ev.usage?.output_tokens ?? result.usage.outputTokens;
          result.stopReason = ev.delta?.stop_reason ?? result.stopReason;
          break;
        case "error":
          throw new Error(`Anthropic stream error: ${ev.error?.message ?? "unknown"}`);
      }
    }
    return result;
  },
};
