import { extractJson, validateJson } from "./json";
import { anthropic } from "./providers/anthropic";
import { bedrock } from "./providers/bedrock";
import { azureOpenAI, openai, openaiCompatible } from "./providers/openai";
import { vertex } from "./providers/vertex";
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type ProviderCredentials,
  type ProviderId,
} from "./types";

export type ModelRef = { provider: ProviderId; name: string };
/** USD per million tokens. */
export type Price = { input: number; output: number };

export type GatewayOptions = {
  /** Looks up the workspace's key for a provider (BYOK). */
  resolveCredentials: (provider: ProviderId) => Promise<ProviderCredentials | null>;
  prices?: Record<string, Price>;
  providers?: Partial<Record<ProviderId, LLMProvider>>;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ChatOptions = {
  onToken?: (token: string) => void;
  fallback?: ModelRef;
  /** JSON Schema the final answer must match (structured output). */
  outputSchema?: Record<string, unknown>;
};

export type GatewayResult = ChatResponse & {
  model: ModelRef;
  /** Parsed structured output when `outputSchema` was given. */
  json?: unknown;
  costUsd: number | null;
};

const defaultProviders: Record<ProviderId, LLMProvider> = {
  anthropic,
  openai,
  azure_openai: azureOpenAI,
  openai_compatible: openaiCompatible,
  bedrock,
  vertex,
};

const isRetryable = (e: unknown) =>
  (e instanceof ProviderError && e.retryable) || (e instanceof TypeError && /fetch/i.test(e.message));

/**
 * Single entry point for model calls: credential lookup, retries with backoff, fallback model,
 * structured-output validation with one repair attempt, and token/cost accounting.
 */
export class LLMGateway {
  private providers: Record<ProviderId, LLMProvider>;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: GatewayOptions) {
    this.providers = { ...defaultProviders, ...opts.providers };
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  cost(model: string, usage: { inputTokens: number; outputTokens: number }): number | null {
    const price = this.opts.prices?.[model];
    if (!price) return null;
    return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  }

  async chat(model: ModelRef, req: Omit<ChatRequest, "model">, options: ChatOptions = {}): Promise<GatewayResult> {
    try {
      return await this.chatWithModel(model, req, options);
    } catch (error) {
      if (!options.fallback) throw error;
      return this.chatWithModel(options.fallback, req, options);
    }
  }

  /** Embeds texts in batches. Throws if the provider has no embeddings API. */
  async embed(model: ModelRef, input: string[], signal?: AbortSignal): Promise<number[][]> {
    const provider = this.providers[model.provider];
    if (!provider.embed) throw new ProviderError(`${model.provider} does not offer embeddings`);
    const creds = await this.opts.resolveCredentials(model.provider);
    if (!creds) throw new ProviderError(`No API key configured for ${model.provider}. Add one in Settings.`);
    const out: number[][] = [];
    for (let i = 0; i < input.length; i += 64) {
      const batch = input.slice(i, i + 64);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await provider.embed({ model: model.name, input: batch, signal }, creds);
          out.push(...res.vectors);
          break;
        } catch (error) {
          if (!(error instanceof ProviderError && error.retryable) || attempt >= this.retries) throw error;
          await this.sleep(500 * 2 ** attempt);
        }
      }
    }
    return out;
  }

  private async chatWithModel(model: ModelRef, req: Omit<ChatRequest, "model">, options: ChatOptions) {
    const provider = this.providers[model.provider];
    const creds = await this.opts.resolveCredentials(model.provider);
    if (!creds) throw new ProviderError(`No API key configured for ${model.provider}. Add one in Settings.`);

    let messages = req.messages;
    if (options.outputSchema) {
      messages = [
        {
          role: "system",
          content: `Respond with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(options.outputSchema)}`,
        },
        ...messages,
      ];
    }

    const call = (msgs: ChatMessage[]) =>
      this.withRetries(() =>
        provider.chat(
          { ...req, model: model.name, messages: msgs, jsonMode: Boolean(options.outputSchema) },
          creds,
          options.onToken,
        ),
      );

    let response = await call(messages);
    let usage = { ...response.usage };
    let json: unknown;

    if (options.outputSchema && response.toolCalls.length === 0) {
      let error = parseAgainst(response.text, options.outputSchema);
      if (error) {
        const repair = await call([
          ...messages,
          { role: "assistant", content: response.text },
          { role: "user", content: `That reply was not valid: ${error}. Reply with only the corrected JSON object.` },
        ]);
        usage = add(usage, repair.usage);
        response = { ...repair, usage };
        error = parseAgainst(response.text, options.outputSchema);
        if (error) throw new ProviderError(`Model output did not match the output schema: ${error}`);
      }
      json = extractJson(response.text);
    }

    return { ...response, usage, model, json, costUsd: this.cost(model.name, usage) };
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= this.retries || !isRetryable(error)) throw error;
        await this.sleep(250 * 2 ** attempt);
      }
    }
  }
}

function parseAgainst(text: string, schema: Record<string, unknown>): string | null {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch {
    return "the response is not JSON";
  }
  return validateJson(value, schema);
}

const add = (a: { inputTokens: number; outputTokens: number }, b: { inputTokens: number; outputTokens: number }) => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});
