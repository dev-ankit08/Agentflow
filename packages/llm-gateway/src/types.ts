export type ProviderId = "anthropic" | "openai" | "azure_openai" | "openai_compatible" | "bedrock" | "vertex";

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolDef = { name: string; description?: string; inputSchema: Record<string, unknown> };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Ask for a JSON object (structured output); the gateway validates and repairs it. */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string | null;
};

export type ProviderCredentials = { apiKey: string; baseUrl?: string | null };

/** One provider's wire format. Adapters use fetch directly so they work with any compatible endpoint. */
export interface LLMProvider {
  id: ProviderId;
  chat(req: ChatRequest, creds: ProviderCredentials, onToken?: (token: string) => void): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(message);
  }
}
