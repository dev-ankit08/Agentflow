import { evaluate, renderTemplate, toText } from "@agentflow/expression-engine";
import type { ModelRef, NodeDef } from "@agentflow/flow-schema";
import type { ChatMessage, LLMGateway, ToolDef } from "@agentflow/llm-gateway";
import { withContext } from "./context";
import type { PromptParts } from "./debug";
import { untrusted } from "./guardrails";
import { redactPII } from "./redact";
import type { NodeContext, NodeHandler } from "./types";

type Of<T extends NodeDef["type"]> = Extract<NodeDef, { type: T }>;
type Usage = { tokensIn: number; tokensOut: number; cost: number | null };

const addUsage = (u: Usage, r: { usage: { inputTokens: number; outputTokens: number }; costUsd: number | null }) => {
  u.tokensIn += r.usage.inputTokens;
  u.tokensOut += r.usage.outputTokens;
  if (r.costUsd !== null) u.cost = (u.cost ?? 0) + r.costUsd;
};

/** One model call with an optional tool loop over connector tools (used by Supervisor workers). */
async function agentLoop(
  ctx: NodeContext,
  model: ModelRef,
  messages: ChatMessage[],
  toolRefs: string[],
  usage: Usage,
  maxRounds = 4,
) {
  const tools = toolRefs.length ? await ctx.tools.describe(toolRefs) : [];
  for (let round = 0; ; round++) {
    await ctx.services.checkBudget?.();
    const res = await ctx.gateway.chat(model, {
      messages,
      tools: tools.length && round < maxRounds ? tools : undefined,
      maxTokens: 1024,
      signal: ctx.signal,
    });
    addUsage(usage, res);
    if (res.toolCalls.length === 0) return res.text;
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const def = tools.find((t) => t.name === call.name);
      const result = def
        ? await ctx.tools.call(def.ref, call.arguments)
        : { text: `Tool ${call.name} is not allowed`, data: null, isError: true };
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: untrusted(def?.ref ?? call.name, result.text || JSON.stringify(result.data)),
      });
    }
  }
}

/**
 * Asks a model for durable facts about the customer in a conversation. Shared by the Memory node's
 * "extract" mode and the API's background extraction job.
 */
export async function extractFacts(
  gateway: LLMGateway,
  model: ModelRef,
  conversation: { role: string; content: string }[],
  signal?: AbortSignal,
) {
  const transcript = conversation
    .map((t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.content}`)
    .join("\n");
  const res = await gateway.chat(
    model,
    {
      messages: [
        {
          role: "system",
          content:
            "Extract durable facts about the customer worth remembering for future conversations (preferences, account details, ongoing issues). Use short third-person statements. Return an empty list if there are none.",
        },
        { role: "user", content: transcript },
      ],
      maxTokens: 400,
      signal,
    },
    {
      outputSchema: {
        type: "object",
        properties: { facts: { type: "array", items: { type: "string" } } },
        required: ["facts"],
      },
    },
  );
  return {
    facts: ((res.json as { facts?: unknown[] })?.facts ?? []).map(toText).filter((f) => f.trim()),
    model: `${res.model.provider}/${res.model.name}`,
    tokensIn: res.usage.inputTokens,
    tokensOut: res.usage.outputTokens,
    costUsd: res.costUsd,
  };
}

const supervisor: NodeHandler<Of<"supervisor">> = {
  type: "supervisor",
  async run(ctx, node) {
    const c = node.config;
    const scope = ctx.scope();
    const usage: Usage = { tokensIn: 0, tokensOut: 0, cost: null };
    const supervisorContext = withContext(c.instructions, c.contextRules, scope);
    const workerTraces: Record<string, unknown> = {};
    const prompts: PromptParts[] = [];
    ctx.meta({ prompts });
    const roster = c.workers.map((w) => `- ${w.id}: ${w.description}`).join("\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${supervisorContext.system}\n\nYou coordinate these specialists. Delegate by calling them with a clear task; when you have what you need, write the final answer yourself.\n${roster}`,
      },
      ...ctx.state.conversation.slice(0, -1).map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: renderTemplate(c.task, scope) },
    ];
    prompts.push({
      label: "supervisor",
      system: messages[0]!.content as string,
      context: supervisorContext.context,
      user: messages[messages.length - 1]!.content as string,
      historyTurns: messages.length - 2,
      tools: c.workers.map((w) => w.id),
    });
    const tools: ToolDef[] = c.workers.map((w) => ({
      name: w.id,
      description: w.description,
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "What this specialist should do" } },
        required: ["task"],
      },
    }));
    const steps: { worker: string; task: string; result: string }[] = [];
    const workerSystem = (worker: (typeof c.workers)[number], task: string) => {
      const built = withContext(worker.systemPrompt, worker.contextRules, scope);
      if (built.trace) workerTraces[worker.id] = built.trace;
      prompts.push({
        label: `specialist: ${worker.id}`,
        system: built.system,
        context: built.context,
        user: task,
        historyTurns: 0,
        tools: worker.tools?.length ? worker.tools : undefined,
      });
      return built.system;
    };

    for (let round = 0; ; round++) {
      const final = round >= c.maxSteps;
      await ctx.services.checkBudget?.();
      const res = await ctx.gateway.chat(
        c.model,
        { messages, tools: final ? undefined : tools, maxTokens: 1024, signal: ctx.signal },
        { onToken: (text) => ctx.emit({ type: "token", nodeId: node.id, text }) },
      );
      addUsage(usage, res);
      if (res.toolCalls.length === 0 || final) {
        ctx.meta({
          model: `${res.model.provider}/${res.model.name}`,
          promptRedacted: redactPII(messages.map((m) => `[${m.role}] ${"content" in m ? m.content : ""}`).join("\n")),
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costUsd: usage.cost,
        });
        const contextRules =
          supervisorContext.trace || Object.keys(workerTraces).length
            ? { ...(supervisorContext.trace && { supervisor: supervisorContext.trace }), workers: workerTraces }
            : undefined;
        return {
          kind: "next",
          output: { text: res.text, path: steps.map((s) => s.worker), steps, ...(contextRules && { contextRules }) },
        };
      }
      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      // Workers asked for in the same turn run at the same time.
      const results = await Promise.all(
        res.toolCalls.map(async (call) => {
          const worker = c.workers.find((w) => w.id === call.name);
          const task = String(call.arguments.task ?? "");
          if (!worker) return { call, text: `Unknown specialist ${call.name}` };
          const text = await agentLoop(
            ctx,
            worker.model ?? c.model,
            [
              { role: "system", content: workerSystem(worker, task) },
              { role: "user", content: task },
            ],
            worker.tools ?? [],
            usage,
          );
          steps.push({ worker: worker.id, task, result: text });
          return { call, text };
        }),
      );
      for (const r of results)
        messages.push({ role: "tool", toolCallId: r.call.id, name: r.call.name, content: r.text });
    }
  },
};

const loop: NodeHandler<Of<"loop">> = {
  type: "loop",
  async run(ctx, node) {
    const c = node.config;
    const loops = (ctx.state.loops ??= {});
    let progress = loops[node.id];
    if (!progress) {
      const items = evaluate(c.items, ctx.scope());
      if (!Array.isArray(items))
        throw new Error(`"${node.label}" needs a list to loop over (got ${toText(items) || "nothing"})`);
      progress = loops[node.id] = { items, index: 0, results: [] };
    } else {
      // The body has come back: collect its result and move to the next item.
      if (c.collect) progress.results.push(evaluate(c.collect, ctx.scope()));
      progress.index++;
    }
    const limit = Math.min(progress.items.length, c.maxIterations);
    if (progress.index < limit) {
      const item = progress.items[progress.index];
      ctx.state.variables[c.itemVariable] = item;
      ctx.state.variables[`${c.itemVariable}_index`] = progress.index;
      return {
        kind: "next",
        handle: "each",
        output: { item, index: progress.index, count: limit, results: progress.results },
      };
    }
    delete loops[node.id];
    return {
      kind: "next",
      handle: "done",
      output: { results: progress.results, count: limit, truncated: progress.items.length > c.maxIterations },
    };
  },
};

const parallel: NodeHandler<Of<"parallel">> = {
  type: "parallel",
  async run(ctx, node) {
    const scope = ctx.scope();
    const usage: Usage = { tokensIn: 0, tokensOut: 0, cost: null };
    const taskTraces: Record<string, unknown> = {};
    const prompts: PromptParts[] = [];
    ctx.meta({ prompts });
    const taskContext = (t: (typeof node.config.tasks)[number], user: string) => {
      const built = withContext(t.systemPrompt, t.contextRules, scope);
      if (built.trace) taskTraces[t.id] = built.trace;
      prompts.push({ label: `task: ${t.id}`, system: built.system, context: built.context, user, historyTurns: 0 });
      return built;
    };
    await ctx.services.checkBudget?.();
    const replies = await Promise.all(
      node.config.tasks.map(async (t) => {
        const user = renderTemplate(t.userPrompt, scope);
        const res = await ctx.gateway.chat(t.model, {
          messages: [
            { role: "system", content: taskContext(t, user).system },
            { role: "user", content: user },
          ],
          maxTokens: 1024,
          signal: ctx.signal,
        });
        addUsage(usage, res);
        return [t.id, res.text] as const;
      }),
    );
    ctx.meta({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.cost });
    const byId = Object.fromEntries(replies);
    return {
      kind: "next",
      output: {
        ...byId,
        combined: node.config.tasks.map((t) => `## ${t.label}\n${byId[t.id]}`).join("\n\n"),
        ...(Object.keys(taskTraces).length && { contextRules: taskTraces }),
      },
    };
  },
};

const wait: NodeHandler<Of<"wait">> = {
  type: "wait",
  async run(ctx, node) {
    const c = node.config;
    let resumeAt: Date;
    if (c.until) {
      resumeAt = new Date(toText(evaluate(c.until, ctx.scope())));
      if (Number.isNaN(resumeAt.getTime())) throw new Error(`"${node.label}": "until" is not a valid date`);
    } else {
      resumeAt = new Date(Date.now() + (c.minutes ?? 0) * 60_000);
    }
    if (resumeAt.getTime() <= Date.now()) return { kind: "next", output: { waited: false } };
    return {
      kind: "pause",
      reason: "wait",
      resumeAt: resumeAt.toISOString(),
      output: { resumeAt: resumeAt.toISOString() },
    };
  },
};

const memory: NodeHandler<Of<"memory">> = {
  type: "memory",
  async run(ctx, node) {
    const c = node.config;
    const endUserId = typeof ctx.state.user.id === "string" ? ctx.state.user.id : null;
    if (!endUserId) return { kind: "next", output: { facts: [], text: "", skipped: "No signed-in end user" } };
    if (!ctx.services.memory) throw new Error("Memory is not available");
    const scope = ctx.scope();

    if (c.mode === "read") {
      const query = toText(evaluate(c.query || "trigger.message", scope));
      const facts = await ctx.services.memory.read(endUserId, query, c.topK);
      return { kind: "next", output: { facts, text: facts.map((f) => `- ${f}`).join("\n") } };
    }

    let facts: string[];
    if (c.mode === "write") {
      const value = evaluate(c.facts ?? '""', scope);
      facts = (Array.isArray(value) ? value : [value]).map(toText).filter((f) => f.trim());
    } else {
      if (!c.model) throw new Error(`"${node.label}" needs a model to extract facts`);
      await ctx.services.checkBudget?.();
      const res = await extractFacts(ctx.gateway, c.model, ctx.state.conversation, ctx.signal);
      ctx.meta({ model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd });
      facts = res.facts;
    }
    if (facts.length) await ctx.services.memory.write(endUserId, facts);
    return { kind: "next", output: { facts, stored: facts.length } };
  },
};

export const orchestrationHandlers = { supervisor, loop, parallel, wait, memory };
