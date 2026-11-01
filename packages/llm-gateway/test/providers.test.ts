import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMGateway, bedrockTarget, signRequest, type ProviderId } from "../src";

afterEach(() => vi.unstubAllGlobals());

describe("AWS SigV4", () => {
  it("matches the AWS documentation example (IAM ListUsers)", () => {
    const headers = signRequest(
      {
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
      },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      "us-east-1",
      "iam",
      new Date("2015-08-30T12:36:00Z"),
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("AWS Bedrock", () => {
  it("parses IAM keys or API keys, region or endpoint", () => {
    expect(bedrockTarget({ apiKey: "AKIAABCDEFGHIJKLMNOP:secret", baseUrl: "eu-west-1" })).toMatchObject({
      endpoint: "https://bedrock-runtime.eu-west-1.amazonaws.com",
      region: "eu-west-1",
      iam: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secret" },
    });
    expect(bedrockTarget({ apiKey: "bedrock-api-key-xyz" }).iam).toBeNull();
  });

  it("calls the Converse API, signed, with tools and tool results", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        output: {
          message: {
            content: [{ text: "Checking" }, { toolUse: { toolUseId: "t1", name: "lookup", input: { q: "1042" } } }],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 6 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const gw = new LLMGateway({
      resolveCredentials: async () => ({ apiKey: "AKIAABCDEFGHIJKLMNOP:wJalrXUtnFEMI", baseUrl: "us-east-1" }),
    });
    const res = await gw.chat(
      { provider: "bedrock" as ProviderId, name: "anthropic.claude-sonnet-v1:0" },
      {
        messages: [
          { role: "system", content: "Be brief" },
          { role: "user", content: "order 1042?" },
          { role: "assistant", content: "", toolCalls: [{ id: "t0", name: "lookup", arguments: {} }] },
          { role: "tool", toolCallId: "t0", name: "lookup", content: "ok" },
        ],
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      },
    );
    expect(res.text).toBe("Checking");
    expect(res.toolCalls).toEqual([{ id: "t1", name: "lookup", arguments: { q: "1042" } }]);
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 6 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-v1%3A0/converse");
    expect((init.headers as Record<string, string>).authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAABCDEFGHIJKLMNOP\/\d{8}\/us-east-1\/bedrock\/aws4_request/,
    );
    const body = JSON.parse(init.body as string);
    expect(body.system).toEqual([{ text: "Be brief" }]);
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [{ toolResult: { toolUseId: "t0", content: [{ text: "ok" }] } }],
    });
    expect(body.toolConfig.tools[0].toolSpec).toMatchObject({
      name: "lookup",
      inputSchema: { json: { type: "object" } },
    });
  });

  it("uses Bedrock API keys as bearer tokens", async () => {
    const fetch = vi.fn(async () => Response.json({ output: { message: { content: [{ text: "hi" }] } } }));
    vi.stubGlobal("fetch", fetch);
    await new LLMGateway({ resolveCredentials: async () => ({ apiKey: "ABSK-test-key" }) }).chat(
      { provider: "bedrock", name: "m" },
      { messages: [{ role: "user", content: "x" }] },
    );
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ABSK-test-key");
  });
});

describe("Google Vertex", () => {
  it("exchanges a service-account JWT for a token and streams Gemini output", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const sa = {
      client_email: "bot@demo.iam.gserviceaccount.com",
      private_key: privateKey,
      project_id: "demo-project",
    };
    let assertion = "";
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        assertion = new URLSearchParams(init.body as string).get("assertion")!;
        return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      }
      const chunks = [
        { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
        {
          candidates: [
            {
              content: { parts: [{ text: "lo" }, { functionCall: { name: "lookup", args: { q: "1" } } }] },
              finishReason: "STOP",
            },
          ],
        },
        { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } },
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const tokens: string[] = [];
    const res = await new LLMGateway({
      resolveCredentials: async () => ({ apiKey: JSON.stringify(sa), baseUrl: "europe-west4" }),
    }).chat(
      { provider: "vertex", name: "gemini-2.5-flash" },
      {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      },
      { onToken: (t) => tokens.push(t) },
    );
    expect(res.text).toBe("Hello");
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(res.toolCalls).toEqual([{ id: "call_0", name: "lookup", arguments: { q: "1" } }]);
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 3 });

    const { payload } = await jwtVerify(assertion, await importSPKI(publicKey, "RS256"));
    expect(payload).toMatchObject({
      iss: sa.client_email,
      aud: "https://oauth2.googleapis.com/token",
      scope: expect.stringContaining("cloud-platform"),
    });
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/demo-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ya29.test");
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe("lookup");
  });

  it("explains a bad service-account key", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const gw = new LLMGateway({ resolveCredentials: async () => ({ apiKey: "not json" }) });
    await expect(gw.chat({ provider: "vertex", name: "m" }, { messages: [] })).rejects.toThrow(/service-account JSON/);
  });
});
