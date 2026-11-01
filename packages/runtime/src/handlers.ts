import { evaluate, isTruthy, renderTemplate } from "@agentflow/expression-engine";
import type { NodeDef } from "@agentflow/flow-schema";
import type { ChatMessage } from "@agentflow/llm-gateway";
import { withContext } from "./context";
import { runGuardrail, untrusted } from "./guardrails";
import { orchestrationHandlers } from "./handlers-orchestration";
import { redactPII } from "./redact";
import type { NodeHandler } from "./types";

type Of<T extends NodeDef["type"]> = Extract<NodeDef, { type: T }>;

const start: NodeHandler<Of<"start">> = {
  type: "start",
  async run(ctx) {
    return { kind: "next", output: ctx.state.trigger };
  },
};

const agent: NodeHandler<Of<"agent">> = {
  type: "agent",
  async run(ctx, node) {
    const c = node.config;
    const scope = ctx.scope();
    // Context rules decide, from variables, which context blocks this agent receives.
    const { system, context, trace: contextTrace } = withContext(c.systemPrompt, c.contextRules, scope);
    const user = renderTemplate(c.userPrompt, scope);
    // Earlier turns of the conversation, so agents keep context in multi-turn chats.
    const history = ctx.state.conversation.slice(0, -1);
    // Recorded up front so the debugger shows what was sent even if the call fails.
    const prompt = {
      system,
      context,
      user,
      historyTurns: history.length,
      tools: c.tools?.length ? c.tools : undefined,
    };
    ctx.meta({ prompts: [prompt] });
    const messages: ChatMessage[] = [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: user },
    ];

    // Repeated questions can be answered from the cache, but never for agents with tools (calls have side effects).
    const cacheQuery =
      ctx.services.cache && c.cache !== false && !c.tools?.length
        ? {
            flowId: ctx.flow.id,
            nodeId: node.id,
            model: `${c.model.provider}/${c.model.name}`,
            context: JSON.stringify([system, history, c.outputSchema ?? null, c.temperature ?? null]),
            input: user,
          }
        : null;
    const cached = cacheQuery ? await ctx.services.cache!.lookup(cacheQuery).catch(() => null) : null;
    if (cached) {
      if (!c.outputSchema) ctx.emit({ type: "token", nodeId: node.id, text: cached.text });
      ctx.meta({
        model: `cache (${cacheQuery!.model})`,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        prompts: [{ ...prompt, cached: true }],
      });
      return {
        kind: "next",
        output: {
          text: cached.text,
          output: cached.json ?? cached.text,
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          model: c.model.name,
          cached: true,
          ...(contextTrace && { contextRules: contextTrace }),
        },
      };
    }

    const tools = c.tools?.length ? await ctx.tools.describe(c.tools) : [];
    const toolCalls: { tool: string; args: unknown; result: unknown; isError: boolean }[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let cost: number | null = null;
    const maxToolCalls = c.maxToolCalls ?? 8;

    for (let round = 0; ; round++) {
      await ctx.services.checkBudget?.();
      const res = await ctx.gateway.chat(
        c.model,
        {
          messages,
          tools: tools.length && round < maxToolCalls ? tools : undefined,
          temperature: c.temperature,
          maxTokens: c.maxTokens ?? 1024,
          signal: ctx.signal,
        },
        {
          fallback: c.fallbackModel,
          outputSchema: c.outputSchema,
          onToken: c.outputSchema ? undefined : (text) => ctx.emit({ type: "token", nodeId: node.id, text }),
        },
      );
      tokensIn += res.usage.inputTokens;
      tokensOut += res.usage.outputTokens;
      if (res.costUsd !== null) cost = (cost ?? 0) + res.costUsd;

      if (res.toolCalls.length === 0) {
        ctx.meta({
          model: `${res.model.provider}/${res.model.name}`,
          promptRedacted: redactPII(messages.map((m) => `[${m.role}] ${"content" in m ? m.content : ""}`).join("\n")),
          tokensIn,
          tokensOut,
          costUsd: cost,
        });
        if (cacheQuery && res.text.trim()) {
          await ctx.services.cache!.store(cacheQuery, { text: res.text, json: res.json }).catch(() => {});
        }
        return {
          kind: "next",
          output: {
            text: res.text,
            output: res.json ?? res.text,
            toolCalls,
            usage: { inputTokens: tokensIn, outputTokens: tokensOut },
            model: res.model.name,
            ...(contextTrace && { contextRules: contextTrace }),
          },
        };
      }

      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const def = tools.find((t) => t.name === call.name);
        let content: string;
        if (!def) {
          content = JSON.stringify({ error: `Tool ${call.name} is not allowed for this agent` });
          toolCalls.push({ tool: call.name, args: call.arguments, result: content, isError: true });
        } else {
          const result = await ctx.tools.call(def.ref, call.arguments);
          content = untrusted(def.ref, result.text || JSON.stringify(result.data));
          toolCalls.push({ tool: def.ref, args: call.arguments, result: result.data, isError: result.isError });
        }
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      }
    }
  },
};

const decision: NodeHandler<Of<"decision">> = {
  type: "decision",
  async run(ctx, node) {
    const scope = ctx.scope();
    const match = node.config.outcomes.find((o) => isTruthy(evaluate(o.condition, scope)));
    const handle = match?.id ?? node.config.defaultOutcome;
    return { kind: "next", handle, output: { outcome: handle } };
  },
};

const assignment: NodeHandler<Of<"assignment">> = {
  type: "assignment",
  async run(ctx, node) {
    const changed: Record<string, unknown> = {};
    for (const a of node.config.assignments) {
      // Each assignment sees the ones before it.
      const value = evaluate(a.value, ctx.scope());
      ctx.state.variables[a.variable] = value;
      changed[a.variable] = value;
    }
    return { kind: "next", output: changed };
  },
};

const mcpTool: NodeHandler<Of<"mcp_tool">> = {
  type: "mcp_tool",
  async run(ctx, node) {
    const scope = ctx.scope();
    const args = Object.fromEntries(Object.entries(node.config.args).map(([k, f]) => [k, evaluate(f, scope)]));
    ctx.meta({ input: { tool: node.config.tool, args } });
    const result = await ctx.tools.call(`${node.config.connectorId}/${node.config.tool}`, args);
    if (result.isError) throw new Error(`Tool ${node.config.tool} failed: ${result.text}`);
    return { kind: "next", output: { result: result.data, text: result.text } };
  },
};

const http: NodeHandler<Of<"http">> = {
  type: "http",
  async run(ctx, node) {
    const scope = ctx.scope();
    const url = renderTemplate(node.config.url, scope);
    if (!/^https?:\/\//i.test(url)) throw new Error(`HTTP node needs an http(s) URL, got "${url}"`);
    const headers = Object.fromEntries(
      Object.entries(node.config.headers ?? {}).map(([k, v]) => [k, renderTemplate(v, scope)]),
    );
    const body = node.config.body ? renderTemplate(node.config.body, scope) : undefined;
    ctx.meta({ input: { method: node.config.method, url } });
    const res = await ctx.fetch(url, { method: node.config.method, headers, body, signal: ctx.signal });
    const text = await res.text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      // Not JSON; keep the text.
    }
    return { kind: "next", output: { status: res.status, ok: res.ok, response } };
  },
};

const end: NodeHandler<Of<"end">> = {
  type: "end",
  async run(ctx, node) {
    const scope = ctx.scope();
    const message = node.config.message ? renderTemplate(node.config.message, scope) : undefined;
    const output = node.config.output
      ? Object.fromEntries(Object.entries(node.config.output).map(([k, f]) => [k, evaluate(f, scope)]))
      : undefined;
    return { kind: "end", message, output, outcome: node.config.outcome };
  },
};

const knowledge: NodeHandler<Of<"knowledge">> = {
  type: "knowledge",
  async run(ctx, node) {
    if (!ctx.services.knowledge) throw new Error("Knowledge search is not available");
    const query = String(evaluate(node.config.query, ctx.scope()) ?? "").trim();
    ctx.meta({ input: { query } });
    const chunks = query
      ? await ctx.services.knowledge.search(query, { sources: node.config.sources, topK: node.config.topK })
      : [];
    const citations = chunks.map((c, i) => ({ n: i + 1, title: c.title, uri: c.uri }));
    // Passages are data, not instructions: wrap them before they reach a prompt.
    const context = chunks.length
      ? untrusted("knowledge", chunks.map((c, i) => `[${i + 1}] ${c.title}\n${c.text}`).join("\n\n"))
      : "No relevant passages were found.";
    return { kind: "next", output: { chunks, context, citations, found: chunks.length } };
  },
};

const approval: NodeHandler<Of<"approval">> = {
  type: "approval",
  async run(ctx, node) {
    if (!ctx.services.approvals) throw new Error("Approvals are not available");
    const scope = ctx.scope();
    const message = renderTemplate(node.config.message, scope);
    const expiresAt = new Date(Date.now() + node.config.timeoutMinutes * 60_000);
    const approvalId = await ctx.services.approvals.request({
      runId: ctx.runId,
      nodeId: node.id,
      message,
      approverRole: node.config.approverRole,
      expiresAt,
    });
    return {
      kind: "pause",
      reason: "approval",
      output: { approvalId, message, expiresAt: expiresAt.toISOString() },
      message: renderTemplate(node.config.pendingMessage, scope),
    };
  },
};

const handoff: NodeHandler<Of<"handoff">> = {
  type: "handoff",
  async run(ctx, node) {
    if (!ctx.services.handoffs) throw new Error("Handoff is not available");
    const transcript = ctx.state.conversation
      .map((t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.content}`)
      .join("\n");
    let summary = ctx.state.conversation
      .filter((t) => t.role === "user")
      .map((t) => `- ${t.content}`)
      .slice(-5)
      .join("\n");
    if (node.config.summaryModel) {
      await ctx.services.checkBudget?.();
      const res = await ctx.gateway.chat(node.config.summaryModel, {
        messages: [
          {
            role: "system",
            content: "Summarise this support conversation for a human agent in three short bullet points.",
          },
          { role: "user", content: transcript },
        ],
        maxTokens: 300,
        signal: ctx.signal,
      });
      summary = res.text;
      ctx.meta({
        model: `${res.model.provider}/${res.model.name}`,
        tokensIn: res.usage.inputTokens,
        tokensOut: res.usage.outputTokens,
        costUsd: res.costUsd,
      });
    }
    const handoffId = await ctx.services.handoffs.create({
      runId: ctx.runId,
      queue: node.config.queue,
      summary,
      transcript,
    });
    let ticket: unknown = null;
    if (node.config.connectorId && node.config.tool) {
      const ref = `${node.config.connectorId}/${node.config.tool}`;
      const [def] = await ctx.tools.describe([ref]);
      const accepted = Object.keys((def?.inputSchema.properties ?? {}) as Record<string, unknown>);
      const all: Record<string, unknown> = { summary, transcript, queue: node.config.queue, handoff_id: handoffId };
      const args = accepted.length
        ? Object.fromEntries(Object.entries(all).filter(([k]) => accepted.includes(k)))
        : all;
      const result = await ctx.tools.call(ref, args);
      if (result.isError) throw new Error(`Could not create the ticket: ${result.text}`);
      ticket = result.data;
    }
    return {
      kind: "end",
      status: "handed_off",
      outcome: "escalated",
      message: renderTemplate(node.config.message, ctx.scope()),
      output: { handoffId, queue: node.config.queue, summary, ticket },
    };
  },
};

const guardrail: NodeHandler<Of<"guardrail">> = {
  type: "guardrail",
  async run(ctx, node) {
    const text = renderTemplate(node.config.input, ctx.scope());
    const result = runGuardrail(text, node.config.checks, node.config.action);
    return { kind: "next", handle: result.passed ? "pass" : "fail", output: result };
  },
};

const subflow: NodeHandler<Of<"subflow">> = {
  type: "subflow",
  async run(ctx, node) {
    const scope = ctx.scope();
    const input = Object.fromEntries(Object.entries(node.config.inputs).map(([k, f]) => [k, evaluate(f, scope)]));
    ctx.meta({ input: { flowId: node.config.flowId, input } });
    const output = await ctx.runChild(node.config.flowId, node.config.useDraft, input);
    return { kind: "next", output };
  },
};

const form: NodeHandler<Of<"form">> = {
  type: "form",
  async run(ctx, node) {
    const title = renderTemplate(node.config.title, ctx.scope());
    return {
      kind: "pause",
      reason: "form",
      message: title,
      ui: { title, submitLabel: node.config.submitLabel, fields: node.config.fields },
    };
  },
};

export const handlers: Record<NodeDef["type"], NodeHandler> = {
  start,
  agent,
  decision,
  assignment,
  mcp_tool: mcpTool,
  http,
  end,
  knowledge,
  approval,
  handoff,
  guardrail,
  subflow,
  form,
  ...orchestrationHandlers,
} as Record<NodeDef["type"], NodeHandler>;
