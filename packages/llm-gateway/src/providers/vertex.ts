import { SignJWT, importPKCS8 } from "jose";
import { ensureOk, sseData } from "../sse";
import {
  ProviderError,
  type ChatMessage,
  type ChatResponse,
  type LLMProvider,
  type ProviderCredentials,
} from "../types";

type ServiceAccount = { client_email: string; private_key: string; project_id: string; token_uri?: string };
type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

/** Converts chat messages to Gemini `contents` (system instruction separate; tool results are user turns). */
export function toGemini(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents: { role: "user" | "model"; parts: Part[] }[] = [];
  const push = (role: "user" | "model", parts: Part[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ text: m.content }]);
    else if (m.role === "assistant") {
      const parts: Part[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.arguments } });
      if (parts.length) push("model", parts);
    } else if (m.role === "tool")
      push("user", [{ functionResponse: { name: m.name, response: { content: m.content } } }]);
  }
  return { system, contents };
}

export function parseServiceAccount(raw: string): ServiceAccount {
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new ProviderError("Google Vertex needs the service-account JSON key as the API key");
  }
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new ProviderError("The service-account JSON is missing client_email, private_key or project_id");
  }
  return sa;
}

const tokens = new Map<string, { token: string; expires: number }>();

/** OAuth access token for a service account (JWT bearer grant), cached until shortly before it expires. */
export async function accessToken(sa: ServiceAccount, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cached = tokens.get(sa.client_email);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/cloud-platform" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience(tokenUri)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  await ensureOk(res, "Google OAuth");
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokens.set(sa.client_email, { token: data.access_token, expires: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

/** The base URL is the location (default us-central1). */
export function vertexUrl(creds: ProviderCredentials, sa: ServiceAccount, model: string) {
  const location = (creds.baseUrl || "us-central1").trim();
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${sa.project_id}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

/** Google Vertex AI (Gemini models) with streaming and function calling. */
export const vertex: LLMProvider = {
  id: "vertex",
  async chat(req, creds, onToken) {
    const sa = parseServiceAccount(creds.apiKey);
    const token = await accessToken(sa);
    const { system, contents } = toGemini(req.messages);
    const res = await fetch(vertexUrl(creds, sa, req.model), {
      method: "POST",
      signal: req.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        contents,
        ...(system && { systemInstruction: { parts: [{ text: system }] } }),
        generationConfig: {
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.maxTokens !== undefined && { maxOutputTokens: req.maxTokens }),
          ...(req.jsonMode && !req.tools?.length && { responseMimeType: "application/json" }),
        },
        ...(req.tools?.length && {
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description ?? "",
                parameters: t.inputSchema,
              })),
            },
          ],
        }),
      }),
    });
    await ensureOk(res, "Google Vertex");

    const result: ChatResponse = {
      text: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: null,
    };
    for await (const data of sseData(res)) {
      const chunk = JSON.parse(data) as {
        candidates?: { content?: { parts?: (Part & { text?: string })[] }; finishReason?: string }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if ("text" in part && part.text) {
          result.text += part.text;
          onToken?.(part.text);
        } else if ("functionCall" in part) {
          result.toolCalls.push({
            id: `call_${result.toolCalls.length}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
          });
        }
      }
      if (chunk.candidates?.[0]?.finishReason) result.stopReason = chunk.candidates[0].finishReason;
      if (chunk.usageMetadata) {
        result.usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
    }
    return result;
  },
};
