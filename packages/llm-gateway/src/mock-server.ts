import { createServer, type Server } from "node:http";
import { mockEmbedding, mockReply } from "./mock";

/**
 * OpenAI-compatible HTTP server for the mock model (streaming chat completions).
 * Add it in Settings as provider "OpenAI-compatible" with base URL http://localhost:<port>/v1.
 */
export function startMockLlm(port: number, { delayMs = 15 } = {}): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          data: [
            { id: "mock-1", object: "model" },
            { id: "mock-embed", object: "model" },
          ],
        }),
      );
    }
    if (req.method === "POST" && req.url?.endsWith("/embeddings")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { input } = JSON.parse(raw) as { input: string | string[] };
      const texts = Array.isArray(input) ? input : [input];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          object: "list",
          data: texts.map((t, index) => ({ object: "embedding", index, embedding: mockEmbedding(t) })),
          usage: { prompt_tokens: Math.ceil(raw.length / 4), total_tokens: Math.ceil(raw.length / 4) },
        }),
      );
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      return res.end();
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: Parameters<typeof mockReply>[0] & { model?: string };
    let reply: ReturnType<typeof mockReply>;
    try {
      body = JSON.parse(raw);
      reply = mockReply(body);
    } catch (error) {
      // Answer instead of leaving the request hanging.
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `mock model failed: ${(error as Error).message}` } }));
    }
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 0 };
    const base = { id: "mock", object: "chat.completion.chunk", model: body.model };

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if ("toolCall" in reply) {
      const args = JSON.stringify(reply.toolCall.arguments);
      usage.completion_tokens = Math.ceil(args.length / 4);
      const call = {
        index: 0,
        id: "call_mock",
        type: "function",
        function: { name: reply.toolCall.name, arguments: args },
      };
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [call] } }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      usage.completion_tokens = Math.ceil(reply.content.length / 4);
      for (const piece of reply.content.match(/.{1,12}/gs) ?? []) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    send({ ...base, choices: [], usage });
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
