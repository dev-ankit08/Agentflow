import type { FastifyReply } from "fastify";
import type { RunEvent } from "@agentflow/runtime";

/**
 * Streams run events as server-sent events on the current response (works for POST, so the
 * message and the stream travel in one request). Headers set by plugins such as CORS are kept.
 */
export function openSse(reply: FastifyReply) {
  const headers = { ...reply.getHeaders() } as Record<string, string>;
  reply.raw.writeHead(200, {
    ...headers,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.hijack();
  const send = (event: RunEvent) => {
    if (!reply.raw.destroyed) reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const sendRaw = (type: string, data: unknown) => {
    if (!reply.raw.destroyed) reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const close = () => {
    if (!reply.raw.destroyed) reply.raw.end();
  };
  return { send, sendRaw, close };
}

/** Runs `work` while streaming its events; always ends the stream, reporting failures as an error event. */
export async function streamRun(reply: FastifyReply, work: (emit: (e: RunEvent) => void) => Promise<unknown>) {
  const sse = openSse(reply);
  try {
    await work(sse.send);
  } catch (error) {
    sse.send({ type: "error", message: (error as Error).message });
  } finally {
    sse.close();
  }
}
