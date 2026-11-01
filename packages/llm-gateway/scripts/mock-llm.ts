import { startMockLlm } from "../src/mock-server";

const port = Number(process.env.MOCK_LLM_PORT ?? 4010);
await startMockLlm(port);
console.log(`✓ Mock LLM listening on http://localhost:${port}/v1 (model "mock-1")`);
