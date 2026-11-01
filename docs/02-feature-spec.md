# 02 — Feature Specification

Each section ends with **acceptance criteria (AC)**. Phase tags: **[P1]** MVP, **[P2]** Business‑ready, **[P3]** Enterprise, **[P4]** Ecosystem (see `05-roadmap-and-backlog.md`).

---

## 1. Flow Builder (canvas)

### 1.1 Layout
- **Left:** node palette (searchable, grouped: Triggers · AI · Logic · Data · People · Output).
- **Centre:** infinite canvas (React Flow) with zoom, pan, minimap, snap‑to‑grid, auto‑layout.
- **Right:** properties panel for the selected node / edge.
- **Bottom:** Test console (chat simulator + run timeline + variable inspector).
- **Top bar:** flow name, environment badge (Draft / Live), Save, Test, Publish, Version history, Share.

### 1.2 Interactions [P1]
- Drag node from palette → drop on canvas; connect by dragging from an output handle to an input handle.
- Invalid connections are blocked (e.g., two edges from a non‑branching output; cycles without a Loop/Supervisor node).
- Undo/redo (Ctrl+Z / Ctrl+Y), copy/paste (also across flows), multi‑select, delete, duplicate.
- Inline validation: nodes with errors show a red badge; Publish is disabled until the flow validates.
- Sticky notes / comments on nodes [P1 notes, P3 threaded comments].

**AC:** A user can build Start → Agent → Decision → (two) End nodes in under 2 minutes without docs; invalid graphs cannot be published; undo restores the last 50 actions.

---

## 2. Node catalogue

All nodes share: `id`, `label`, `description`, `onError` (stop / continue / route to error edge), `timeoutMs`, `retries`.

| Node | Phase | Key configuration | Outputs |
|---|---|---|---|
| **Start / Trigger** | P1 (chat, webhook) · P3 (cron, email, CRM event) | Trigger type, input schema, auth | `{{trigger.*}}` |
| **AI Agent** | P1 | Model, system prompt, user prompt template, tools, knowledge, memory, temperature, max tokens, output schema, fallback model | `{{<node>.output}}`, `{{<node>.text}}`, `{{<node>.usage}}` |
| **Decision** | P1 | Ordered outcomes, each with a condition (rule builder or formula); default outcome | One edge per outcome |
| **Assignment** | P1 | List of `variable = formula` | Updated variables |
| **MCP Tool** | P1 | Connector, tool, argument mapping (formula per arg), approval required? | `{{<node>.result}}` |
| **HTTP Request** | P1 | Method, URL, headers, body (formulas), secret refs | `{{<node>.response}}` |
| **End / Response** | P1 | Message template, structured payload, **outcome tag** | — |
| **Knowledge (RAG)** | P2 | Sources, top‑k, min score, query formula | `{{<node>.chunks}}`, `{{<node>.citations}}` |
| **Human Approval** | P2 | Approvers (users/roles), channel (inbox/Slack/email), message, timeout & timeout path | Approved / Rejected / Timed‑out edges |
| **Handoff** | P2 | Target (helpdesk connector / inbox), summary prompt, queue | — (ends AI part of run) |
| **Guardrail** | P2 | Checks (PII, injection, topic, custom LLM policy), action (block / redact / flag) | Pass / Fail edges |
| **Screen / Form** | P2 | Fields (text, select, date, buttons), validation | `{{<node>.values}}` |
| **Subflow** | P2 | Flow reference, input mapping, output mapping | Mapped outputs |
| **Supervisor / Router** | P3 | Child agents (as tools), routing instructions, max steps, termination condition | `{{<node>.final}}`, `{{<node>.path}}` |
| **Loop** | P3 | Collection formula, item variable, max iterations | Each / Done edges |
| **Parallel** | P3 | Branches, join strategy (all / first / majority), merge formula | Joined output |
| **Memory** | P3 | Read (query) or Write (facts), scope (end user / account) | `{{<node>.facts}}` |
| **Wait / Delay** | P3 | Duration or until timestamp | — |

**AC (per node):** each node has a JSON schema in `packages/flow-schema`, a properties form generated from it, a handler implementing `NodeHandler`, unit tests, and appears in the test console timeline with its inputs/outputs.

---

## 3. AI Agent configuration

### 3.1 Prompt editor [P1]
- Monaco editor with markdown highlighting and **`{{` autocomplete** listing all variables in scope with types.
- Sections: **System prompt** (role, rules, tone), **User prompt template**, **Few‑shot examples** (table of input → ideal output).
- **Conditional context blocks** [P1]: blocks of text included only when a condition is true.
  ```
  {{#if customer.tier == "Enterprise"}}
  This customer has a dedicated SLA of 4 hours. Offer a call-back.
  {{/if}}
  ```
- Token counter (estimated) and cost preview per call.
- Prompt library: save/insert reusable snippets across flows [P2].

### 3.2 Model settings [P1]
- Provider + model dropdown (only providers with configured keys appear).
- Temperature, max output tokens, top‑p, stop sequences.
- **Fallback model** (used on provider error/timeout).
- **Structured output:** JSON schema builder; the model's response is validated and exposed as typed variables (`{{triage.output.intent}}`).

### 3.3 Tools & knowledge [P1 tools, P2 knowledge]
- Tick which MCP tools / HTTP actions the agent may call (allow‑list). Write tools can be flagged **"requires approval"** → runtime inserts an approval pause before execution [P2].
- Attach knowledge sources; agent gets an automatic retrieval tool.

### 3.4 Versioning & A/B [P2]
- Every save creates a draft version; publish creates an immutable version.
- Side‑by‑side diff of prompts; rollback in one click.
- A/B split: route X% of runs to prompt version B; compare outcome metrics [P3].

**AC:** a builder can reference a previous agent's structured output field in the next agent's prompt via autocomplete; invalid JSON output triggers one automatic repair retry, then the error edge.

---

## 4. Variables, context & formulas

### 4.1 Scopes [P1 unless noted]
| Scope | Syntax | Lifetime | Example |
|---|---|---|---|
| Trigger input | `{{trigger.message}}` | Run | user's chat message |
| Flow variable | `{{order_id}}` | Run | set by Assignment |
| Node output | `{{triage.output.intent}}` | Run | from an agent's schema |
| Session / user | `{{user.email}}`, `{{user.plan}}` | Session | from signed identity JWT |
| Conversation | `{{conversation.history}}`, `{{conversation.turn}}` | Session | chat history |
| Org constants | `{{org.support_email}}` | Permanent | set in settings |
| Secrets | `{{secret.STRIPE_KEY}}` | Permanent | usable only in tool/HTTP config, **never** in prompts |
| Memory [P3] | `{{memory.facts}}` | Long‑term | per end user |

### 4.2 Types
`text`, `number`, `boolean`, `date`, `object`, `list<T>`, `file`. Variables declared in the **Variables panel** with name, type, default, description, and "exposed as input/output" flags (for subflows and API).

### 4.3 Formula language [P1]
Safe, sandboxed (parsed into AST; no `eval`, no I/O).

```
Literals     "text"  42  3.14  true  false  null  [1,2]  {"a":1}
Operators    + - * / %   == != > >= < <=   AND OR NOT   & (string concat)
Access       order.items[0].sku   user["email"]
Functions    IF(cond, a, b)   AND(...)  OR(...)  ISBLANK(x)  COALESCE(a,b,...)
             LEN(x)  LOWER(s)  UPPER(s)  TRIM(s)  CONTAINS(s, sub)  STARTSWITH(s, p)  SPLIT(s, sep)  JOIN(list, sep)
             REGEX_MATCH(s, pattern)   NUMBER(x)  TEXT(x)  ROUND(n, d)  SUM(list)  MIN(list)  MAX(list)
             NOW()  TODAY()  DATEADD(d, n, "day")  DATEDIFF(a, b, "hour")  FORMAT_DATE(d, "YYYY-MM-DD")
             JSONPATH(obj, "$.items[*].price")  FILTER(list, "item.price > 10")  MAP(list, "item.sku")
```
- Type checking in the editor with inline errors; preview evaluates against the last test run's values.

### 4.4 Decision rule builder [P1]
- UI rows: `[variable] [operator] [value]` combined with AND/OR groups; "Advanced" switches to formula.
- Outcomes evaluated top‑down; first match wins; Default outcome required.

### 4.5 Variable inspector [P1]
- In test console, clicking any step shows the full variable snapshot before/after that step.

**AC:** a Decision routes correctly on `{{triage.output.intent}} == "refund" AND {{order.amount}} > 500`; secrets referenced in a prompt cause a validation error; formula errors are shown before publish.

---

## 5. Connectors & MCP

### 5.1 Connector Hub [P1]
- **Add MCP server:** URL (Streamable HTTP) + auth (none / API key / bearer / OAuth 2.1). Local **stdio** servers supported for self‑run/dev via a sandboxed process launcher.
- On connect: discover **tools, resources, prompts**; show each tool's name, description, input schema.
- Test a tool call from the UI with sample arguments.
- **Pre‑built connectors** packaged as MCP definitions: Zendesk, HubSpot, Shopify, Google Workspace, Slack, Postgres [P1–P2]; Salesforce, Stripe, M365, Jira, ServiceNow, Snowflake, MySQL [P2–P3].
- Credentials encrypted at rest; scoped per workspace; never shown again after save.

### 5.2 Tool permissions [P1 allow‑list, P2 approval flags]
- Per agent allow‑list; per tool classification **read / write / destructive**; write/destructive may require approval.

### 5.3 MCP resources as context [P2]
- Resources (e.g., a customer record, a document) can be attached to an agent as context, refreshed per run.

### 5.4 Flows as MCP servers [P4]
- Any published flow can be exposed at an MCP endpoint so other AI clients (Claude, Copilot, IDEs) can call it as a tool.

**AC:** adding a public MCP server lists its tools within 5 s; an agent can call a tool and use the result in the next node; a tool not on the allow‑list is never callable even if the model requests it.

---

## 6. High‑impact capabilities (H1–H12)

### H1 — Outcome templates & marketplace [P1 five templates · P4 marketplace]
- Gallery filtered by department and outcome; each template has preview, required connectors, expected metric.
- **Install wizard:** connect required connectors → map fields → pick knowledge → test → publish.
- Launch templates: L1 Support deflection, Order status & returns, Lead qualification & booking, IT/HR helpdesk, Invoice processing.
- Marketplace [P4]: partners publish templates/connectors; ratings, installs, versioning.
- **AC:** a new user installs "Support deflection", connects a help‑centre URL, and has a working widget in ≤ 15 minutes.

### H2 — Testing & Evaluation Studio [P2]
- **Datasets:** rows of `input`, optional `expected`, `rubric`, `tags`; import CSV; "add from trace" button.
- **Scorers:** exact/contains match, JSON‑schema valid, LLM‑judge (rubric, 1–5), tool‑called‑correctly, latency, cost.
- **Sandbox mode:** write tools are mocked (recorded responses) unless marked safe.
- **Publish gate:** project setting "min pass rate X%" and "no regression > Y% vs. last live version"; Publish blocked with a report if failed.
- **AC:** running a 50‑case dataset produces per‑case scores and an aggregate; a regression blocks publish with a link to failing cases.

### H3 — Observability & tracing [P1 basic · P2 full]
- Run list with filters (flow, status, outcome, date, user, cost).
- Run detail: timeline of steps; per step input/output, prompt sent (PII‑redacted), tokens, latency, cost, errors; graph overlay highlighting the path taken.
- **Replay from step** with optional edited variables (in Draft).
- **AC:** every run shows total cost and per‑node cost; replay reproduces the run path in Draft.

### H4 — ROI dashboard [P2]
- Inputs: baseline cost per human ticket, average handle time, hourly cost.
- Metrics: runs, resolution/deflection rate, escalation rate, conversions, hours saved, $ saved, AI cost, net ROI, CSAT (thumbs/1–5 in widget), trends, per flow.
- Scheduled email report (weekly) [P3].
- **AC:** ROI numbers recompute from outcome tags; exporting CSV matches dashboard totals.

### H5 — Human‑in‑the‑loop & handoff [P2]
- Approval inbox in dashboard (+ Slack/email notifications with approve/reject links).
- Run pauses durably (state saved) and resumes on decision; timeout path supported.
- Handoff creates a ticket/chat in helpdesk via connector with an AI summary + transcript; widget tells end user a human will follow up (or switches to live chat if connector supports it).
- **AC:** a paused run survives a worker restart and resumes after approval; handoff ticket contains summary and transcript.

### H6 — Guardrails & governance [P2 guardrails · P3 enterprise]
- Guardrail node + automatic pre/post checks: PII detect & redact (email, phone, card, Aadhaar/PAN, SSN patterns), prompt‑injection heuristics on tool/RAG content, blocked topics, max response length.
- RBAC roles: Owner, Admin, Builder, Reviewer, Viewer [P2 basic, P3 custom]; SSO/SAML, SCIM [P3]; audit log of all config changes and approvals [P3]; data retention policy per workspace [P3].
- **AC:** a card number typed by the user never appears in stored traces; a Viewer cannot edit or publish.

### H7 — Knowledge & long‑term memory [P2 knowledge · P3 memory]
- Sources: file upload (PDF, DOCX, TXT, MD, CSV), website crawl (sitemap/URL list), Google Drive, Notion [P2]; SharePoint, Confluence [P3].
- Scheduled re‑sync; citations shown in widget answers.
- Memory: after a session, extract facts about the end user; Memory node reads relevant facts; end‑user delete request supported.
- **AC:** answer includes citation links; updated doc is reflected after re‑sync; deleted user's memories are purged.

### H8 — Proactive & background agents [P3]
- Triggers: schedule (cron UI), webhook, inbound email, file drop, CRM change event.
- Batch mode over a record list with concurrency limit (configurable, small by default in the prototype).
- **AC:** a nightly cron flow runs, appears in traces, and posts to Slack.

### H9 — Conversation insights [P3]
- Nightly job clusters user questions, labels topics, flags clusters with high escalation / low confidence / negative feedback.
- Each flagged cluster offers suggested actions (add doc, edit prompt, new branch) with deep links.
- **AC:** insights page lists top 10 unresolved topics with example questions.

### H10 — Collaboration [P2 versions & review · P3 real‑time]
- Version history with visual diff; "Request review" before publish (Reviewer approves).
- Real‑time co‑editing with presence (Yjs) and threaded comments [P3].
- **AC:** two users editing simultaneously see each other's changes within 1 s without conflicts.

### H11 — Cost controls [P2]
- Budgets per flow / workspace / month; at 80% alert, at 100% action (alert only / switch to fallback model / stop).
- Response cache for identical questions (configurable TTL) [P2]; semantic cache [P3].
- Provider prompt‑caching enabled automatically where supported.
- **AC:** exceeding a hard budget stops new runs with a friendly widget message and an admin alert.

### H12 — White‑label / agency mode [P4]
- Partner account → client orgs; custom domain for dashboard & widget; brand colours/logo; client billing with markup; cross‑client overview.
- **AC:** client users see only the partner's brand; partner sees all clients' usage.

---

## 7. Deploy & channels

### 7.1 Embed widget [P1]
```html
<script src="https://cdn.agentflow.ai/w.js" data-flow="flw_abc123" async></script>
```
- Web component in Shadow DOM; modes: **bubble**, **inline** (`<agentflow-chat>` element), **full page**, **headless** (JS API).
- Theming: colours, logo, avatar, welcome message, quick‑reply chips, position, language.
- **Identity:** host site passes a signed JWT (`AgentFlow.identify(token)`) → `{{user.*}}` variables.
- Security: allowed domains list; per‑widget public key; basic rate limit per session.
- Features: streaming responses, markdown, citations, buttons/forms (Screen node), file upload, thumbs feedback, "talk to a human".
- JS API: `open()`, `close()`, `send(text)`, `setVariables({...})`, `on('message' | 'handoff' | 'end', cb)`.

### 7.2 API & SDKs [P1 REST/SSE · P2 SDKs]
- `POST /v1/flows/{id}/runs` (start), `POST /v1/runs/{id}/messages` (continue), `GET /v1/runs/{id}/stream` (SSE), `GET /v1/runs/{id}`.
- API keys per workspace with scopes. `@agentflow/sdk` (JS/TS), `@agentflow/react` component.

### 7.3 Channels [P2–P4]
Slack, Microsoft Teams, WhatsApp (Business API), email [P2–P3]; WordPress & Shopify plugins [P3]; voice (WebRTC) [P4].

### 7.4 Environments [P1 Draft/Live · P2 Staging]
- Draft (editable) → Staging (optional) → Live; publish creates immutable version; rollback to any previous version.

**AC:** pasting the snippet on a plain HTML page shows a working chat bubble; host page CSS does not affect the widget; a non‑allowed domain is rejected.

---

## 8. Model providers [P1]
- Providers: **Anthropic (Claude)**, **OpenAI**, **Azure OpenAI**, **OpenAI‑compatible** (Ollama, vLLM, Groq, Together, etc.) [P1]; AWS Bedrock, Google Vertex [P2].
- BYOK per workspace; platform credits option [P2].
- Uniform features across providers: streaming, tool calling, structured output (native or emulated), token usage & cost.
- **AC:** the same flow runs with Claude and with GPT by changing only the model dropdown.

---

## 9. AI flow generator [P4]
- Describe a process in plain language → generates a draft flow (nodes, prompts, variables, suggested connectors) for the user to review.

---

## 10. Workspace & admin [P1 basic]
- Sign up / login (email + Google), org & workspace creation, invite members, roles, API keys, provider keys, billing page [P2], usage page.

---

## 11. Traceability matrix (requirements → spec → architecture)

| Requirement | Spec section | Architecture (`03-architecture.md`) |
|---|---|---|
| Drag‑and‑drop multi‑agent orchestration | §1, §2 (Agent, Supervisor, Parallel, Subflow) | §2 Builder, §5 Runtime executor |
| MCP connections to infuse data | §5 | §2 Connector Hub, §5.5 MCP client |
| Easily deployable to any website | §7 | §2 Widget, §7 API |
| User‑friendly UI to connect agents & add prompts | §1, §3 | §2 Builder |
| Variables passed between agents, conditional context | §4, §3.1 | §4 Flow schema, §5.3 Expression engine |
| Any model (Claude/GPT/Azure/BYO) | §8 | §5.4 LLM Gateway |
| H1 Templates | §6 H1 | §3.1 Templates |
| H2 Evals | §6 H2 | §3.2 Eval Service |
| H3 Tracing | §6 H3 | §3.3 Tracing |
| H4 ROI | §6 H4 | §3.4 Analytics |
| H5 Human‑in‑the‑loop | §6 H5 | §3.5 Approval/Handoff |
| H6 Governance | §6 H6 | §3.6 Policy & Identity |
| H7 Knowledge & memory | §6 H7 | §3.7 Knowledge & Memory |
| H8 Proactive agents | §6 H8 | §3.8 Triggers |
| H9 Insights | §6 H9 | §3.9 Insights |
| H10 Collaboration | §6 H10 | §3.10 Collaboration |
| H11 Cost controls | §6 H11 | §3.11 Usage & budgets |
| H12 White‑label | §6 H12 | §3.12 Tenancy |
