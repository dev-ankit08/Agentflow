import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMGateway, ProviderError, validateJson, type ProviderId } from "../src";
import { mockReply } from "../src/mock";

const sse = (events: unknown[], status = 200) =>
  new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
    status,
    headers: { "content-type": "text/event-stream" },
  });

const creds = async (p: ProviderId) => ({
  apiKey: `key-${p}`,
  baseUrl: p === "azure_openai" ? "https://res.openai.azure.com" : null,
});

function stubFetch(...responses: Response[]) {
  const fn = vi.fn(async () => responses.shift() ?? new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const openaiText = (text: string) =>
  sse([
    { choices: [{ index: 0, delta: { content: text.slice(0, 3) } }] },
    { choices: [{ index: 0, delta: { content: text.slice(3) }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    "[DONE]",
  ]);

afterEach(() => vi.unstubAllGlobals());

describe("LLMGateway", () => {
  it("streams OpenAI text, reports usage and cost", async () => {
    const fetch = stubFetch(openaiText("Hello there"));
    const gw = new LLMGateway({ resolveCredentials: creds, prices: { "gpt-x": { input: 1, output: 2 } } });
    const tokens: string[] = [];
    const res = await gw.chat(
      { provider: "openai", name: "gpt-x" },
      { messages: [{ role: "user", content: "hi" }] },
      {
        onToken: (t) => tokens.push(t),
      },
    );
    expect(res.text).toBe("Hello there");
    expect(tokens).toEqual(["Hel", "lo there"]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(res.costUsd).toBeCloseTo((10 + 8) / 1e6);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key-openai");
  });

  it("parses OpenAI tool calls split across chunks", async () => {
    stubFetch(
      sse([
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_", arguments: '{"order' } }] },
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { name: "order", arguments: '_id":"42"}' } }] } },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]),
    );
    const gw = new LLMGateway({ resolveCredentials: creds });
    const res = await gw.chat(
      { provider: "openai_compatible", name: "m" },
      { messages: [{ role: "user", content: "x" }] },
    );
    expect(res.toolCalls).toEqual([{ id: "c1", name: "get_order", arguments: { order_id: "42" } }]);
  });

  it("speaks the Anthropic Messages format, including tool use", async () => {
    const fetch = stubFetch(
      sse([
        { type: "message_start", message: { usage: { input_tokens: 12 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "lookup" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      ]),
    );
    const gw = new LLMGateway({ resolveCredentials: creds });
    const res = await gw.chat(
      { provider: "anthropic", name: "claude-x" },
      {
        messages: [
          { role: "system", content: "Be brief" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "", toolCalls: [{ id: "t0", name: "lookup", arguments: {} }] },
          { role: "tool", toolCallId: "t0", name: "lookup", content: "ok" },
        ],
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      },
    );
    expect(res.text).toBe("Checking");
    expect(res.toolCalls).toEqual([{ id: "tu1", name: "lookup", arguments: { q: "a" } }]);
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.system).toBe("Be brief");
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }],
    });
  });

  it("uses the Azure v1 endpoint with an api-key header", async () => {
    const fetch = stubFetch(openaiText("ok"));
    await new LLMGateway({ resolveCredentials: creds }).chat(
      { provider: "azure_openai", name: "my-deployment" },
      { messages: [{ role: "user", content: "x" }] },
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://res.openai.azure.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-azure_openai");
  });

  it("validates structured output and repairs it once", async () => {
    stubFetch(openaiText("not json"), openaiText('{"intent":"refund"}'));
    const res = await new LLMGateway({ resolveCredentials: creds }).chat(
      { provider: "openai", name: "m" },
      { messages: [{ role: "user", content: "x" }] },
      { outputSchema: { type: "object", properties: { intent: { enum: ["refund", "other"] } }, required: ["intent"] } },
    );
    expect(res.json).toEqual({ intent: "refund" });
    expect(res.usage.inputTokens).toBe(20);
  });

  it("retries retryable errors, then falls back to another model", async () => {
    const err = () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
    const fetch = stubFetch(err(), err(), err(), openaiText("from fallback"));
    const res = await new LLMGateway({ resolveCredentials: creds, sleep: async () => {} }).chat(
      { provider: "anthropic", name: "a" },
      { messages: [{ role: "user", content: "x" }] },
      { fallback: { provider: "openai", name: "b" } },
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(res.text).toBe("from fallback");
    expect(res.model.name).toBe("b");
  });

  it("does not retry client errors and explains missing keys", async () => {
    stubFetch(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    const gw = new LLMGateway({ resolveCredentials: creds, sleep: async () => {} });
    await expect(gw.chat({ provider: "openai", name: "m" }, { messages: [] })).rejects.toThrow(
      "OpenAI error 401: bad key",
    );
    const none = new LLMGateway({ resolveCredentials: async () => null });
    await expect(none.chat({ provider: "anthropic", name: "m" }, { messages: [] })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe("validateJson", () => {
  it("checks types, required fields, enums and arrays", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "integer" }, b: { type: "array", items: { type: "string" } } },
    };
    expect(validateJson({ a: 1, b: ["x"] }, schema)).toBeNull();
    expect(validateJson({}, schema)).toBe("$.a is required");
    expect(validateJson({ a: 1.5 }, schema)).toBe("$.a must be integer");
    expect(validateJson({ a: 1, b: [2] }, schema)).toBe("$.b[0] must be string");
  });
});

describe("mock model", () => {
  it("fills output schemas from the user's message", () => {
    const reply = mockReply({
      messages: [
        {
          role: "system",
          content:
            'Respond with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n{"type":"object","properties":{"intent":{"type":"string","enum":["order_status","refund","other"]},"order_id":{"type":"string"}}}',
        },
        { role: "user", content: "Where is my order 1042?" },
      ],
    });
    expect(JSON.parse((reply as { content: string }).content)).toEqual({ intent: "order_status", order_id: "1042" });
  });

  it("calls the first tool, then answers with its result", () => {
    const tools = [{ function: { name: "get_order", parameters: { properties: { order_id: { type: "string" } } } } }];
    expect(mockReply({ messages: [{ role: "user", content: "order 1042" }], tools })).toEqual({
      toolCall: { name: "get_order", arguments: { order_id: "1042" } },
    });
    const done = mockReply({
      messages: [
        { role: "user", content: "order 1042" },
        { role: "tool", content: "shipped" },
      ],
      tools,
    });
    expect(done).toEqual({ content: 'Here is what I found for "order 1042": shipped' });
  });
});
