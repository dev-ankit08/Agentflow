# 05 — Roadmap & Backlog

**Estimates** are in ideal engineer-days (d). **Spec** refers to sections of `02-feature-spec.md`. **Arch** refers to sections of `03-architecture.md`.
Scalability and high-traffic work is **not scheduled**. It is a later upgrade (Arch §10).

## Phase overview

| Phase | Weeks | Goal | Exit criteria |
|---|---|---|---|
| **0. Foundations** | 1–2 | Skeleton everyone can build on | `docker compose up` runs all apps; login works; flow schema package is published internally |
| **1. MVP** | 3–10 | Build, test and embed a multi-agent flow with MCP data | Demo: install the "Support deflection" template → test → embed on an HTML page → chat |
| **2. Business-ready** | 11–18 | Trustworthy and measurable for paying pilots | Evals gate publishing, approvals work, ROI dashboard is live, billing is on |
| **3. Enterprise** | 19–28 | Passes enterprise security review; advanced orchestration | SSO/RBAC/audit, supervisor/loop/parallel nodes, background agents |
| **4. Ecosystem** | 29–40 | Growth loops | Marketplace, white-label, flows as MCP servers, AI flow generator |

```
Weeks:  1-2 | 3-10 (MVP)          | 11-18 (Business)    | 19-28 (Enterprise)        | 29-40 (Ecosystem)
        F   | Canvas→Runtime→Widget| Evals·HITL·ROI·RAG  | SSO·Supervisor·Triggers   | Marketplace·White-label
```

---

## Phase 0 — Foundations (weeks 1–2)

| ID | Epic / Story | Spec | Arch | Est |
|---|---|---|---|---|
| F-1 | Turborepo + pnpm monorepo, lint, prettier, Vitest, CI (GitHub Actions) | — | §8 | 2d |
| F-2 | docker-compose: Postgres+pgvector, Redis, MinIO, api, worker, builder | — | §8 | 1.5d |
| F-3 | `packages/db`: Drizzle schema for orgs/workspaces/users/flows/versions/runs/run_steps; migrations; seed | — | §4 | 2d |
| F-4 | Auth (Auth.js email + Google), org & workspace creation, invite, roles (Owner/Admin/Builder/Viewer) | §10 | §2.2, §3.6 | 3d |
| F-5 | `packages/flow-schema`: Flow, Edge, Variable, Trigger and the base Node schema; validator; `schemaVersion` | §2 | §5.1 | 2d |
| F-6 | `packages/ui` design system (shadcn, theme tokens, light/dark) and the app shell with navigation | — | §2.1 | 2d |
| F-7 | `SecretStore` (AES-GCM) + provider-keys settings page | §8 | §6 | 1.5d |

**Total ≈ 14d**

---

## Phase 1 — MVP (weeks 3–10)

### E1. Canvas builder
| ID | Story | Spec | Est |
|---|---|---|---|
| B-1 | As a builder, I can create, rename and delete flows from a list page | §1 | 1d |
| B-2 | As a builder, I can drag nodes from a palette onto a React Flow canvas and connect them | §1.2 | 3d |
| B-3 | Properties panel auto-generated from node schemas | §1.1 | 3d |
| B-4 | Undo/redo, copy/paste, multi-select, auto-layout, minimap | §1.2 | 2.5d |
| B-5 | Inline validation, error badges, Publish blocked on errors | §1.2 | 2d |
| B-6 | Autosave drafts; Draft/Live publish creating an immutable version; rollback | §7.4 | 2d |
| B-7 | Variables panel (declare, type, default, usage links) | §4.2 | 1.5d |

### E2. Expression engine and variables
| ID | Story | Spec | Est |
|---|---|---|---|
| X-1 | Pratt parser + evaluator + function library (§4.3) with unit tests | §4.3 | 4d |
| X-2 | Template renderer for `{{expr}}` and `{{#if}}` blocks | §3.1 | 1.5d |
| X-3 | Type inference from variables and output schemas → `{{` autocomplete in Monaco | §3.1, §4 | 3d |
| X-4 | Decision rule builder UI ↔ formula round-trip | §4.4 | 2d |
| X-5 | Block secrets in prompt templates (validation rule) | §4.1 | 0.5d |

### E3. LLM Gateway
| ID | Story | Spec | Est |
|---|---|---|---|
| L-1 | `LLMProvider` interface; Anthropic adapter (streaming, tools, structured output) | §8 | 2.5d |
| L-2 | OpenAI + Azure OpenAI + OpenAI-compatible adapters | §8 | 3d |
| L-3 | Structured output validation + one repair retry; fallback model | §3.2 | 1.5d |
| L-4 | Usage events + per-model price table; cost per step | §6 H3 | 1d |

### E4. Runtime
| ID | Story | Spec | Est |
|---|---|---|---|
| R-1 | `RunExecutor` in-process implementation, state persistence, guards (max steps/cost) | — | 4d |
| R-2 | Node handlers: Start, Agent (with tool loop), Decision, Assignment, HTTP, MCP Tool, End | §2 | 5d |
| R-3 | Streaming via Redis pub/sub → SSE endpoints; event types | §7.2 | 2d |
| R-4 | Chat continuation (waiting_input → resume) and conversation history variables | §4.1 | 2d |
| R-5 | `TraceSink` → `run_steps`; PII redaction of stored prompts (regex pack v1) | §6 H3, H6 | 2d |

### E5. MCP Connector Hub
| ID | Story | Spec | Est |
|---|---|---|---|
| M-1 | Add MCP server (Streamable HTTP; none/API-key/bearer auth); discover tools/resources | §5.1 | 3d |
| M-2 | Local stdio transport for development | §5.1 | 1.5d |
| M-3 | Tool test runner in the UI | §5.1 | 1d |
| M-4 | Per-agent tool allow-list enforced by the policy layer | §5.2 | 1.5d |
| M-5 | Pre-built connector manifests: Zendesk, Shopify, Google Workspace, Slack, Postgres | §5.1 | 3d |

### E6. Widget and deploy
| ID | Story | Spec | Est |
|---|---|---|---|
| W-1 | Loader script + Preact web component (Shadow DOM), bubble and inline modes | §7.1 | 3d |
| W-2 | Streaming chat UI: markdown, quick replies, thumbs feedback | §7.1 | 2.5d |
| W-3 | Widget sessions API; origin allow-list; per-session rate limit | §7.1 | 2d |
| W-4 | Theming settings + Deploy screen with snippet and live preview | §7.1 | 2d |
| W-5 | Signed identity JWT → `{{user.*}}` | §7.1 | 1.5d |
| W-6 | Public REST API + API keys | §7.2 | 2d |

### E7. Test console, traces and templates
| ID | Story | Spec | Est |
|---|---|---|---|
| T-1 | Test console: chat simulator, timeline, variable inspector, path highlight on canvas | §1.1, §4.5 | 3d |
| T-2 | Runs list + run detail page (basic trace view) | §6 H3 | 2.5d |
| T-3 | Template format + install wizard | §6 H1 | 3d |
| T-4 | Five launch templates authored and tested | §6 H1 | 4d |
| T-5 | E2E Playwright test: template → publish → widget chat | — | 2d |

**Phase 1 total ≈ 97d** (about 8 weeks for 3–4 engineers)

---

## Phase 2 — Business-ready (weeks 11–18)

| ID | Epic / Story | Spec | Arch | Est |
|---|---|---|---|---|
| K-1 | Knowledge sources: upload, website crawl; parsing; chunking; embeddings; pgvector | §6 H7 | §3.7 | 5d |
| K-2 | Hybrid retrieval + Knowledge node + citations in the widget | §6 H7 | §3.7 | 3d |
| K-3 | Scheduled re-sync; Drive + Notion sources | §6 H7 | §3.7 | 3d |
| H-1 | Approval node + `waiting_approval` state + resume job + timeout | §6 H5 | §3.5 | 3d |
| H-2 | Approval inbox UI + Slack/email notifications | §6 H5 | §3.5 | 3d |
| H-3 | Handoff node (helpdesk ticket with summary + transcript) | §6 H5 | §3.5 | 2d |
| H-4 | "Requires approval" flag on write tools → automatic approval pause | §5.2 | §3.6 | 1.5d |
| V-1 | Eval datasets (CRUD, CSV import, add from trace) | §6 H2 | §3.2 | 2.5d |
| V-2 | Eval runner (BullMQ), sandbox mode with mocked write tools | §6 H2 | §3.2 | 3d |
| V-3 | Scorers: exact/contains, JSON schema, LLM judge, tool called, latency, cost | §6 H2 | §3.2 | 3d |
| V-4 | Publish gate + eval results UI | §6 H2 | §3.2 | 2d |
| A-1 | Outcomes + feedback capture; ROI SQL views; daily aggregates job | §6 H4 | §3.4 | 3d |
| A-2 | ROI dashboard UI + baseline settings + CSV export | §6 H4 | §3.4 | 3d |
| G-1 | Guardrail node + policy pre/post checks (PII v2, injection heuristics, topics) | §6 H6 | §3.6 | 4d |
| C-1 | Budgets + BudgetGuard + alerts; response cache | §6 H11 | §3.11 | 3d |
| C-2 | Stripe billing (plans, metered usage) | — | §3.11 | 4d |
| N-1 | Screen/Form node + widget form rendering | §2 | §5.6 | 3d |
| N-2 | Subflow node | §2 | §5.6 | 2d |
| E-1 | Staging environment + version diff + review request | §6 H10, §7.4 | §3.10 | 3d |
| P-1 | Prompt versioning + side-by-side diff + prompt library | §3.4 | — | 2.5d |
| CH-1 | Slack + Teams channels | §7.3 | — | 4d |
| CH-2 | WhatsApp Business channel | §7.3 | — | 3d |
| S-1 | npm SDKs (`@agentflow/sdk`, `@agentflow/react`) | §7.2 | §7 | 2.5d |
| L-5 | Bedrock + Vertex adapters | §8 | §5.4 | 3d |

**Phase 2 total ≈ 75d**

---

## Phase 3 — Enterprise (weeks 19–28)

| ID | Epic / Story | Spec | Arch | Est |
|---|---|---|---|---|
| EN-1 | SSO/SAML + SCIM provisioning | §6 H6 | §3.6 | 6d |
| EN-2 | Custom roles + fine-grained permissions | §6 H6 | §3.6 | 3d |
| EN-3 | Audit log + export | §6 H6 | §3.6 | 3d |
| EN-4 | Data retention policies; zero-retention mode | §6 H6 | §6 | 3d |
| O-1 | Supervisor/Router node (child agents as tools, step budget) | §2 | §5.6 | 5d |
| O-2 | Loop node + Parallel node (join strategies) | §2 | §5.6 | 4d |
| O-3 | Wait/Delay node | §2 | §5.6 | 1d |
| TR-1 | Triggers: schedule, inbound email, file drop, CRM events; batch mode | §6 H8 | §3.8 | 6d |
| MEM-1 | Memory extraction job + Memory node + end-user deletion | §6 H7 | §3.7 | 4d |
| K-4 | SharePoint + Confluence sources; reranking | §6 H7 | §3.7 | 4d |
| CO-1 | Real-time co-editing (Yjs) + presence + threaded comments | §6 H10 | §3.10 | 6d |
| IN-1 | Conversation insights clustering + suggestions UI | §6 H9 | §3.9 | 5d |
| AB-1 | Prompt A/B testing with outcome comparison | §3.4 | — | 3d |
| A-3 | Scheduled ROI email reports | §6 H4 | §3.4 | 1.5d |
| C-3 | Semantic cache | §6 H11 | §3.11 | 2d |
| PL-1 | WordPress + Shopify plugins | §7.3 | — | 4d |

**Phase 3 total ≈ 60d**

**Prototype status (core scope built):**
- **Done:** EN-3, EN-4, O-1, O-2 (Parallel waits for every task), O-3, AB-1, and IN-1 (keyword clustering for now, not embeddings).
- **Done in part:**
  - TR-1: schedule and webhook triggers are built; inbound email, file drop, CRM events and batch mode are not.
  - MEM-1: the Memory node does read/write/extract and end users can be deleted, but there is no background extraction job.
  - CO-1: presence, node comments and edit-conflict protection are built, but there is no Yjs co-editing.
  - PL-1: the WordPress plugin is built; Shopify is not.
- **Deferred:** EN-1, EN-2, K-4, A-3 and C-3.

---

## Phase 4 — Ecosystem (weeks 29–40)

| ID | Epic / Story | Spec | Est |
|---|---|---|---|
| MP-1 | Template and connector marketplace (publish, review, rate, install) | §6 H1 | 8d |
| WL-1 | Partner accounts, client orgs, branding, custom domains, rebilling | §6 H12 | 8d |
| MS-1 | Expose flows as MCP servers | §5.4 | 4d |
| AI-1 | AI flow generator (plain text → draft flow) | §9 | 6d |
| VO-1 | Voice channel (WebRTC + STT/TTS) | §7.3 | 8d |
| SH-1 | Self-host package | — | 5d |
| SOC-1 | SOC 2 Type II readiness work | — | ongoing |

---

## Dependencies (critical path)

```
F-3,F-5 ─▶ X-1 ─▶ R-1 ─▶ R-2 ─▶ T-1 ─▶ T-3/T-4 ─▶ MVP demo
             L-1 ─┘      │
             M-1 ────────┘
R-3 ─▶ W-1/W-2 ─▶ W-3
R-5 ─▶ T-2 ─▶ V-1 (add from trace)
R-1 (pause support) ─▶ H-1 ─▶ H-4
A-1 ─▶ A-2 ─▶ IN-1
K-1 ─▶ K-2 ─▶ MEM-1
```

## Definition of done (every story)
- Code reviewed and merged with unit tests. Formula, executor and policy code requires at least 80% coverage.
- Acceptance criteria from the feature spec are demonstrated in the test console or an E2E test.
- No secrets appear in logs or traces. Lint and type-check pass.
- Docs updated: user-facing help for UI features, the API reference for endpoints.

## Suggested team
1 product manager · 1 designer · 2 frontend engineers (canvas, widget) · 3 backend engineers (runtime, gateways, data) · 1 AI engineer (evals, guardrails, RAG) · 1 DevOps engineer (also QA automation in early phases).
