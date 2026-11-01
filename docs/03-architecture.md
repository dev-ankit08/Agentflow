# 03 — Architecture (TypeScript, prototype‑first)

> **Scope:** this architecture targets a **good working prototype**. Scalability and high‑traffic/spike handling are **explicitly deferred** to a later upgrade (§10). Every component sits behind an interface so that upgrade can swap implementations **without breaking** the flow schema, APIs, or widget.

---

## 1. System overview

```
  Builder (Next.js + React Flow) · Dashboards (ROI, traces, evals) · Approval Inbox
  Embed widget (Preact Web Component) · Slack / email channel (later phases)
                                   │
                                   ▼
        API server (Fastify: REST + SSE, auth via Auth.js/JWT, widget domain allow-list)
          ├─ Identity & Tenancy (orgs, workspaces, roles)               [H6, H12]
          ├─ Flow Service (CRUD, versions, Draft/Live, publish gate)    [H2, H10]
          ├─ Connector Hub (MCP registry, credentials, tool permissions)
          ├─ Templates (seeded outcome templates + install wizard)      [H1]
          ├─ Eval Service (datasets, runs, LLM-judge)                   [H2]
          ├─ Analytics (ROI metrics, insights job)                      [H4, H9]
          └─ Usage & Budgets (token/cost metering, limits)              [H11]
                                   │
        Runtime (same codebase, worker process)
          ├─ Graph Executor (in-process; run state persisted to Postgres → pause/resume) [H5, H8]
          ├─ Expression engine + Variable store
          ├─ LLM Gateway (provider adapters: Claude, OpenAI, Azure, OpenAI-compatible; fallback) [H11]
          ├─ MCP Client (@modelcontextprotocol/sdk, HTTP + local stdio)
          ├─ Policy checks (PII redaction, injection heuristics, tool allow-list)   [H6]
          ├─ Knowledge (ingest → chunk → embed → pgvector search)                   [H7]
          ├─ Memory (per-end-user facts)                                            [H7]
          ├─ Approval / Handoff                                                     [H5]
          └─ Trace writer (one row per node step: tokens, cost, I/O)                [H3]
        Background jobs: BullMQ on Redis (cron triggers, ingestion, eval runs, insights) [H8, H2, H9]

 Data: Postgres + pgvector (everything, including traces) · Redis (sessions, SSE pub/sub, BullMQ) · local disk / S3 (files)
```

### 1.1 Technology choices

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language; shared types between canvas and runtime |
| Monorepo | Turborepo + pnpm | Fast builds, shared packages |
| Builder UI | Next.js (App Router), React Flow (xyflow), Tailwind + shadcn/ui, Monaco, Zustand, TanStack Query | Best‑in‑class canvas + forms |
| Widget | Preact + Web Component + Shadow DOM, built with Vite | Small bundle (< 50 KB gz), CSS isolation |
| API | Fastify + Zod (validation) + OpenAPI generation | Fast, typed, documented |
| Auth | Auth.js (email magic link + Google) → JWT | Simple for prototype; SSO added P3 |
| DB | Postgres 16 + pgvector, Drizzle ORM + migrations | Relational + vectors in one DB |
| Queue / cache / pub‑sub | Redis 7 + BullMQ | Background jobs, SSE fan‑out, sessions |
| LLM | Official SDKs: `@anthropic-ai/sdk`, `openai` (also for Azure & OpenAI‑compatible) | First‑party support |
| MCP | `@modelcontextprotocol/sdk` (client) | Official protocol implementation |
| Files | Local disk (dev) / S3‑compatible (MinIO) | Swappable via `FileStore` |
| Testing | Vitest (unit), Playwright (E2E) | Fast, TS‑native |
| Packaging | Docker + docker‑compose | One command local stack |

---

## 2. Core components

### 2.1 Builder (apps/builder)
- Pages: `/flows`, `/flows/[id]` (canvas), `/connectors`, `/templates`, `/knowledge`, `/evals`, `/runs`, `/runs/[id]`, `/analytics`, `/inbox`, `/settings`.
- Canvas state in Zustand; persisted as flow JSON via API (autosave debounce 1 s).
- Node property forms are **generated from each node's Zod/JSON schema** (`packages/flow-schema`) → adding a node type needs no hand‑built form.
- Test console connects to the runtime through the same SSE API the widget uses (single code path).

### 2.2 API server (apps/api)
- Modules: `auth`, `orgs`, `flows`, `versions`, `runs`, `connectors`, `knowledge`, `templates`, `evals`, `analytics`, `approvals`, `usage`, `widget`.
- All requests carry `orgId`/`workspaceId` from JWT; every query filtered by them (repository layer enforces it; Postgres RLS enabled as defence‑in‑depth).
- Public endpoints for the widget authenticate with **widget public key + Origin check + optional end‑user identity JWT**.

### 2.3 Connector Hub
- Registry of connectors (`type: mcp_http | mcp_stdio | http`), encrypted credentials, discovered tool catalogue cached in DB (refresh on demand).
- Pre‑built connector definitions live in `packages/connectors` (manifest: name, MCP URL or launch command, auth type, tool classification read/write).

### 2.4 Embed widget (packages/widget)
- Loader script (`w.js`, ~3 KB) reads `data-flow`, fetches widget config (theme, allowed origins), lazy‑loads the chat bundle.
- Talks to `POST /v1/widget/{flowKey}/sessions`, `POST …/messages`, `GET …/stream` (SSE).
- Renders markdown, citations, buttons/forms, handoff state; stores `sessionId` in `localStorage` (with try/catch fallback to memory).

### 2.5 Worker (apps/worker)
- Hosts the **Runtime** (graph executor + node handlers) and **BullMQ processors** (triggers, ingestion, evals, insights, scheduled reports).
- Prototype: single process; can run multiple replicas later because all state lives in Postgres/Redis.

---

## 3. High‑impact capabilities — technical design

### 3.1 Templates (H1)
- Template = `{ manifest, flowJson, wizardSchema }` stored in `packages/templates` and seeded into `templates` table.
- `flowJson` contains placeholders: `"connectorRef": "$connector.helpdesk"`, `"knowledgeRef": "$knowledge.helpcenter"`.
- Install: clone flow → wizard collects placeholder bindings → replace → validate → Draft flow ready to test.
- Marketplace (P4) adds `publisher_id`, `version`, `rating`, `installs`.

### 3.2 Eval Service (H2)
- Tables: `eval_datasets`, `eval_cases`, `eval_runs`, `eval_results`.
- An eval run enqueues one BullMQ job per case → runtime executes the flow version in **sandbox mode** (`ctx.sandbox = true`): write/destructive tools return recorded mocks; read tools allowed if marked safe.
- Scorers implement `Scorer { name; score(case, runResult): Promise<{score:number; pass:boolean; reason?:string}> }` — built‑ins: `exactMatch`, `contains`, `jsonSchema`, `llmJudge`, `toolCalled`, `latency`, `cost`.
- **Publish gate:** `FlowService.publish()` checks project gate settings against the latest eval run for that version; blocks with report if failing.

### 3.3 Tracing (H3)
- `TraceSink` interface; prototype implementation writes to `run_steps` (Postgres).
- Each step row: `run_id, step_index, node_id, node_type, status, started_at, ended_at, input_json, output_json, prompt_redacted, model, tokens_in, tokens_out, cost_usd, error`.
- Variable snapshot stored per step in `runs.state` history (JSONB) for replay.
- Replay = create new Draft run with `state` copied up to step N, optionally edited, then continue executing from node N.

### 3.4 Analytics & ROI (H4)
- End/Handoff nodes write `outcomes(run_id, flow_id, tag, value, created_at)`.
- Widget feedback writes `feedback(run_id, rating, comment)`.
- ROI query (SQL views): runs, resolution rate = resolved / total, hours saved = resolved × baseline AHT, $ saved = resolved × baseline cost − AI cost, CSAT avg.
- Nightly BullMQ job materialises daily aggregates (`analytics_daily`) to keep the dashboard fast.

### 3.5 Approval & Handoff (H5)
- Approval node: executor writes `approvals` row (`pending`), sets `runs.status = 'waiting_approval'`, persists state, **returns** (no in‑memory waiting).
- Decision via inbox / Slack / email link → `POST /v1/approvals/{id}/decide` → enqueue `resume-run` job → executor loads state and continues on the Approved/Rejected edge.
- Timeouts: delayed BullMQ job fires `timeout` decision if still pending.
- Handoff node: summary agent call → connector tool (`create_ticket`) with summary + transcript → `runs.status = 'handed_off'`.

### 3.6 Policy & Identity (H6)
- `PolicyEngine.check(stage, payload, policy)` called **before LLM**, **after LLM**, **before tool**, **after tool**:
  - PII: regex packs (email, phone, card + Luhn, Aadhaar, PAN, SSN, IBAN) → redact or tokenize (`<PII_EMAIL_1>`) with reversible map kept only in run memory.
  - Injection heuristics on tool/RAG content (instruction‑like patterns, role overrides); flagged content wrapped/quoted or blocked.
  - Tool allow‑list & approval flags enforced here — the model can never call a tool outside the list.
- Identity: `orgs → workspaces → memberships(role)`; roles Owner/Admin/Builder/Reviewer/Viewer; permission checks in API middleware. SSO/SAML/SCIM (P3) via an IdP integration library.
- Audit: `audit_events(actor, action, target, before, after, at)` appended on config changes.

### 3.7 Knowledge & Memory (H7)
- Ingestion job: fetch (upload / crawl / Drive / Notion) → parse (pdf‑parse, mammoth, html‑to‑text) → chunk (~800 tokens, 100 overlap) → embed (provider embeddings, configurable) → `chunks(embedding vector)`.
- Retrieval: hybrid = pgvector cosine + Postgres full‑text (`tsvector`) merged with reciprocal rank fusion; optional rerank (P3).
- Re‑sync: scheduled job compares content hash; re‑embeds changed docs only.
- Memory (P3): post‑session job asks an LLM to extract facts → `memories(end_user_id, fact, embedding, expires_at)`; Memory node retrieves top facts by similarity.

### 3.8 Triggers & background agents (H8)
- Trigger types: `chat`, `webhook` (P1); `schedule`, `email`, `crm_event`, `file_drop` (P3).
- Schedules registered as BullMQ repeatable jobs; webhooks at `POST /v1/hooks/{triggerKey}` (HMAC verification); each enqueues `start-run`.
- Batch: Loop node over records with `concurrency` setting (default 3 in prototype).

### 3.9 Insights (H9)
- Nightly job: embed first user message of each run → cluster (k‑means / HDBSCAN via a small Python‑free JS implementation or simple agglomerative clustering) → LLM labels clusters → join with outcomes/feedback → store `insight_clusters`.

### 3.10 Collaboration (H10)
- P2: immutable `flow_versions`, JSON diff rendered visually (added/removed/changed nodes), review requests (`reviews` table).
- P3: Yjs document per flow synced via `y-websocket` server in the API; persisted snapshot to `flows.draft_json` on idle.

### 3.11 Usage & Budgets (H11)
- LLM Gateway emits `usage_events(run_id, model, tokens_in, tokens_out, cost_usd)`; price table per model in config.
- `BudgetGuard` checked before each LLM call: aggregates month‑to‑date from `usage_daily`; actions alert / fallback / stop.
- Response cache: Redis key = hash(model, prompt, tools, temperature=0 only) with TTL.

### 3.12 Tenancy & white‑label (H12)
- Table `partners`; `orgs.partner_id` nullable. Branding settings on partner and org; custom domain mapping table resolved by Host header (P4).

---

## 4. Data model

```
partners(id, name, branding, domain)
orgs(id, partner_id?, name, plan, settings)
workspaces(id, org_id, name)
users(id, email, name)            memberships(user_id, workspace_id, role)
api_keys(id, workspace_id, hash, scopes)
provider_keys(id, workspace_id, provider, enc_secret, base_url?)

flows(id, workspace_id, name, draft_json, live_version_id, widget_key, settings)
flow_versions(id, flow_id, version, json, status[draft|staging|live|archived], created_by, created_at)
reviews(id, flow_version_id, requested_by, reviewer_id, status)

connectors(id, workspace_id, type, name, config, enc_credentials, tool_catalog, refreshed_at)
tool_permissions(flow_id, node_id, connector_id, tool_name, mode[read|write|destructive], requires_approval)

runs(id, workspace_id, flow_id, flow_version_id, trigger_type, end_user_id?, status[running|waiting_approval|waiting_input|completed|failed|handed_off], state jsonb, sandbox bool, started_at, ended_at, cost_usd)
run_steps(id, run_id, step_index, node_id, node_type, status, input_json, output_json, prompt_redacted, model, tokens_in, tokens_out, cost_usd, error, started_at, ended_at)
messages(id, run_id, role, content, created_at)
approvals(id, run_id, node_id, status, approvers, decided_by, decided_at, expires_at)
outcomes(run_id, flow_id, tag, value, created_at)       feedback(run_id, rating, comment)

knowledge_sources(id, workspace_id, type, config, schedule, last_synced_at)
documents(id, source_id, uri, title, content_hash)
chunks(id, document_id, content, tsv tsvector, embedding vector(1536), metadata)
end_users(id, workspace_id, external_id, traits)        memories(id, end_user_id, fact, embedding, expires_at)

eval_datasets(id, workspace_id, name)   eval_cases(id, dataset_id, input, expected, rubric, tags)
eval_runs(id, dataset_id, flow_version_id, status, summary)   eval_results(id, eval_run_id, case_id, scores, pass)

templates(id, slug, manifest, flow_json, wizard_schema, version)
usage_events(id, workspace_id, run_id, model, tokens_in, tokens_out, cost_usd, at)
budgets(id, scope_type, scope_id, monthly_usd, action)
insight_clusters(id, workspace_id, flow_id, label, size, escalation_rate, examples, period)
analytics_daily(workspace_id, flow_id, day, runs, resolved, escalated, cost_usd, csat)
audit_events(id, org_id, actor_id, action, target, before, after, at)
```
All tenant tables include `workspace_id` (→ `org_id`) and are indexed on it.

---

## 5. Flow definition & runtime

### 5.1 Flow JSON schema (simplified)

```ts
type Flow = {
  schemaVersion: 1;
  id: string;
  name: string;
  variables: VariableDef[];          // { name, type, default?, isInput?, isOutput? }
  triggers: TriggerDef[];            // { type: 'chat' | 'webhook' | 'schedule' | ..., config }
  nodes: NodeDef[];                  // { id, type, label, position:{x,y}, config, onError?, timeoutMs?, retries? }
  edges: EdgeDef[];                  // { id, source, sourceHandle?, target, condition? }
  settings: { maxSteps: number; maxCostUsd: number; defaultModel?: ModelRef };
};
```

### 5.2 Example — "Order support" flow

```json
{
  "schemaVersion": 1,
  "id": "flw_order_support",
  "name": "Order support",
  "variables": [
    { "name": "order_id", "type": "text" },
    { "name": "order", "type": "object" }
  ],
  "triggers": [{ "type": "chat", "config": {} }],
  "nodes": [
    { "id": "start", "type": "start", "label": "Chat", "position": { "x": 0, "y": 0 }, "config": {} },
    { "id": "triage", "type": "agent", "label": "Triage", "position": { "x": 250, "y": 0 },
      "config": {
        "model": { "provider": "anthropic", "name": "claude-haiku-5-5" },
        "systemPrompt": "Classify the customer's intent and extract an order id if present.",
        "userPrompt": "{{trigger.message}}",
        "outputSchema": {
          "type": "object",
          "properties": {
            "intent": { "type": "string", "enum": ["order_status", "refund", "other"] },
            "order_id": { "type": "string" }
          },
          "required": ["intent"]
        }
      } },
    { "id": "route", "type": "decision", "label": "Route", "position": { "x": 500, "y": 0 },
      "config": { "outcomes": [
        { "id": "status", "condition": "triage.output.intent == \"order_status\" AND NOT ISBLANK(triage.output.order_id)" },
        { "id": "refund", "condition": "triage.output.intent == \"refund\"" }
      ], "defaultOutcome": "other" } },
    { "id": "lookup", "type": "mcp_tool", "label": "Get order", "position": { "x": 750, "y": -120 },
      "config": { "connectorId": "con_shopify", "tool": "get_order",
                  "args": { "order_id": "triage.output.order_id" } } },
    { "id": "answer", "type": "agent", "label": "Answer", "position": { "x": 1000, "y": -120 },
      "config": {
        "model": { "provider": "openai", "name": "gpt-5" },
        "systemPrompt": "You are a friendly support agent. Use only the order data provided.{{#if user.plan == \"vip\"}} The customer is VIP: offer free express shipping on the next order.{{/if}}",
        "userPrompt": "Question: {{trigger.message}}\nOrder: {{lookup.result}}"
      } },
    { "id": "handoff", "type": "handoff", "label": "To human", "position": { "x": 750, "y": 120 },
      "config": { "connectorId": "con_zendesk", "summaryPrompt": "Summarise the issue in 3 bullets." } },
    { "id": "done", "type": "end", "label": "Done", "position": { "x": 1250, "y": -120 },
      "config": { "message": "{{answer.text}}", "outcome": "resolved" } }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "triage" },
    { "id": "e2", "source": "triage", "target": "route" },
    { "id": "e3", "source": "route", "sourceHandle": "status", "target": "lookup" },
    { "id": "e4", "source": "route", "sourceHandle": "refund", "target": "handoff" },
    { "id": "e5", "source": "route", "sourceHandle": "other", "target": "handoff" },
    { "id": "e6", "source": "lookup", "target": "answer" },
    { "id": "e7", "source": "answer", "target": "done" }
  ],
  "settings": { "maxSteps": 25, "maxCostUsd": 0.5 }
}
```
*(Formulas in `config` fields such as `condition` and `args` are written without `{{ }}`; text templates such as prompts and messages use `{{ }}`. The validator enforces this rule. The model ids are only examples; the builder lists whatever models the configured providers offer.)*

### 5.3 Expression engine (packages/expression-engine)
- Hand‑written Pratt parser → AST → evaluator with a whitelist of functions (see feature spec §4.3).
- Template renderer for `{{expr}}` and `{{#if}}…{{else}}…{{/if}}` blocks; secrets blocked in prompt templates at validation time.
- Static type inference using flow variable declarations + node output schemas → powers editor autocomplete and validation.

### 5.4 LLM Gateway (packages/llm-gateway)

```ts
interface LLMProvider {
  id: 'anthropic' | 'openai' | 'azure_openai' | 'openai_compatible' | 'bedrock' | 'vertex';
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest, onToken?: (t: string) => void): Promise<ChatResponse>; // tools + structured output
  embed?(texts: string[], model: string): Promise<number[][]>;
}
```
- `ChatRequest` normalises messages, tools (JSON schema), `responseFormat` (JSON schema), temperature, maxTokens.
- Structured output: native where supported, otherwise "tool‑as‑schema" or JSON mode + validation + one repair retry.
- `Gateway.chat()` wraps provider with: budget check → policy pre‑check → call (timeout, retry with backoff on 429/5xx) → fallback model on failure → policy post‑check → usage event → cache write.

### 5.5 MCP client (packages/mcp-client)
- Per connector a lazily‑created `Client` from `@modelcontextprotocol/sdk` using `StreamableHTTPClientTransport` (remote) or `StdioClientTransport` (local, launched with restricted env and working directory).
- Connection cache per workspace+connector inside the worker, closed when idle.
- `listTools()` cached in `connectors.tool_catalog`; `callTool(name, args)` passes through `PolicyEngine` (allow‑list, approval) and records a trace step.
- Agent nodes expose allowed MCP tools to the LLM as function tools; the tool‑call loop is capped by `maxToolCalls` (default 8).

### 5.6 Graph executor (packages/runtime)

```ts
interface NodeHandler<C = unknown> {
  type: string;
  run(ctx: RunContext, node: NodeDef<C>): Promise<NodeResult>;
}
type NodeResult =
  | { kind: 'next'; output?: unknown; handle?: string }     // continue (handle chooses outgoing edge)
  | { kind: 'pause'; reason: 'approval' | 'input' | 'wait'; resumeKey: string }
  | { kind: 'end'; output?: unknown; outcome?: string };

interface RunExecutor {           // seam for the later durable-engine upgrade
  start(flowVersionId: string, input: TriggerInput, opts?: RunOptions): Promise<RunId>;
  resume(runId: RunId, resumeKey: string, payload: unknown): Promise<void>;
}
```
**Algorithm (in‑process implementation):**
1. Load flow version + run state (`currentNodeId`, `variables`, `stepIndex`).
2. Loop: get handler for node type → apply timeout/retry → `run()` → write trace step + persist state (one transaction).
3. `next` → choose edge by `handle` (or the only edge) → continue; `pause` → set run status and exit; `end` → finalise, write outcome.
4. Guards: `stepIndex ≤ maxSteps`, cumulative cost ≤ `maxCostUsd`, loop iteration caps.
5. Parallel node: run branches with `Promise.all` (prototype), merge per join strategy.
6. Streaming: agent handler forwards tokens to Redis channel `run:{id}` → API SSE endpoint relays to widget/test console.
7. Chat continuation: End node in chat mode returns to `waiting_input`; the next user message resumes at the Start node with conversation history preserved (configurable "resume at node").

**Idempotency:** write tool calls include `idempotencyKey = runId:stepIndex`; on resume after crash, a step already recorded as completed is not re‑executed.

---

## 6. Security architecture (prototype baseline)
- Secrets (provider keys, connector creds) encrypted with AES‑256‑GCM using `MASTER_KEY` env (`SecretStore` interface → KMS later).
- Widget: allowed‑origins check, per‑session token issued at session start, simple rate limit per session/IP (Redis counter).
- End‑user identity: host signs JWT with workspace secret (HS256) or registered public key (RS256).
- PII redaction before persisting traces; raw content kept only in run memory.
- Stdio MCP servers only allowed for self‑run/dev in prototype; remote MCP over HTTPS for hosted use.
- Details & threat model: `07-security-and-compliance.md`.

---

## 7. Public API (v1, summary)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/flows/{flowId}/runs` | Start a run (API key) |
| POST | `/v1/runs/{runId}/messages` | Send user message / resume input |
| GET | `/v1/runs/{runId}/stream` | SSE: tokens, step events, final |
| GET | `/v1/runs/{runId}` | Run status, outputs, outcome |
| POST | `/v1/approvals/{id}/decide` | Approve / reject |
| POST | `/v1/hooks/{triggerKey}` | Webhook trigger (HMAC) |
| POST | `/v1/widget/{widgetKey}/sessions` | Widget session start |
| POST | `/v1/widget/{widgetKey}/sessions/{sid}/messages` | Widget message |
| GET | `/v1/widget/{widgetKey}/sessions/{sid}/stream` | Widget SSE |

SSE event types: `token`, `step_started`, `step_completed`, `message`, `ui` (Screen node form), `handoff`, `paused`, `done`, `error`.

---

## 8. Repository layout

```
agentflow/
  apps/
    builder/            Next.js builder + dashboards
    api/                Fastify API (REST + SSE)
    worker/             Runtime + BullMQ processors
  packages/
    flow-schema/        Zod schemas for flow & every node type (shared)
    expression-engine/  Parser, evaluator, template renderer, type inference
    runtime/            Graph executor, NodeHandlers, RunExecutor, TraceSink
    llm-gateway/        Provider adapters, routing, fallback, usage, cache
    mcp-client/         MCP connection manager + tool calling
    policy/             PII, injection heuristics, tool ACL
    widget/             Preact web component + loader
    sdk-js/             TypeScript client SDK
    connectors/         Pre-built connector manifests
    templates/          Outcome templates (flow JSON + wizard)
    eval-kit/           Scorers and eval runner helpers
    ui/                 Shared design system (shadcn/Tailwind)
    db/                 Drizzle schema + migrations + seed
  infra/
    docker-compose.yml  postgres(pgvector), redis, api, worker, builder, minio
    Dockerfile.*        per app
  docs/                 (these documents)
```

---

## 9. Prototype quality targets

| Area | Target |
|---|---|
| Correctness | Every node type runs end‑to‑end in the test console; pause/resume and replay survive a worker restart |
| Responsiveness | First token to widget ≈ 2 s (excluding LLM provider time); widget loader < 300 ms |
| Setup | `docker compose up` brings the whole stack up locally; one seed script loads demo templates |
| Security basics | Encrypted secrets, widget origin allow‑list, per‑agent tool allow‑list, PII redaction in traces |
| Tests | Unit tests for expression engine and node handlers; E2E test: install template → publish → chat via widget |

---

## 10. Deferred: scalability upgrade (later — not part of the prototype)

High‑traffic and spike handling are **explicitly out of scope** for now. To make sure nothing breaks when that upgrade happens, the prototype keeps these seams:

| Seam | Prototype implementation | Can later become |
|---|---|---|
| `RunExecutor` | In‑process executor + Postgres state | Durable workflow engine |
| `JobQueue` | BullMQ | Any managed queue |
| `TraceSink` | Postgres `run_steps` | Dedicated analytics store |
| `LLMProvider` / Gateway | Single key per provider | Key/region pools, rate limiting, semantic cache |
| `SecretStore` | AES‑GCM with env key | Cloud KMS / Key Vault |
| `FileStore` | Local disk / MinIO | Cloud object storage |
| Tenancy | `workspace_id` on every table | Sharding / multi‑region |
| Flow JSON | `schemaVersion: 1` + migrators | New versions without breaking stored flows |
