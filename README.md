# AgentFlow

Visual builder for multi-agent AI workflows with MCP data connections, pluggable LLMs and one-line website embedding.
Planning docs live in [`docs/`](docs/README.md). This repository is at **Phase 3 — Enterprise (core)**. SSO/SAML/SCIM, custom roles, live co-editing (CRDT),
emailed reports, semantic caching, SharePoint/Confluence, Shopify and inbound email are still to come.
The account-based integrations (AWS Bedrock, Google Vertex, Slack, Microsoft Teams, WhatsApp, Stripe billing) are built
and tested against local fakes, but **not yet against the real services** — see
[docs/08-integrations-setup.md](docs/08-integrations-setup.md) to try them with your own credentials.

## What you can do

1. **Build** flows on a drag-and-drop canvas: Start, AI Agent, Supervisor, Parallel, Decision, Assignment, Loop, Wait,
   Guardrail, Subflow, Knowledge, Memory, MCP Tool, HTTP Request, Approval, Form, Handoff and End nodes, with `{{variables}}`, conditional `{{#if}}` context in
   prompts, formulas, structured agent outputs, undo/redo, copy/paste.
2. **Use any model**: Anthropic (Claude), OpenAI, Azure OpenAI, AWS Bedrock, Google Vertex (Gemini) or any OpenAI-compatible endpoint, with your own keys and an
   optional fallback model per agent.
3. **Connect data** through any MCP server (Streamable HTTP); agents can call allowed tools, or use an MCP Tool node.
4. **Test** a draft in the test console, with streaming replies, a step timeline and each node's output.
5. **Publish** immutable versions (with rollback) and **embed** the agent on any website with one `<script>` tag.
6. **Trace** every run: prompts (with personal data redacted), tool calls, tokens and outcome.
7. Start from **5 outcome templates**: support deflection, order status, lead qualification, IT/HR helpdesk, invoice processing.
8. **Answer from your knowledge**: paste documents or add web pages; Knowledge nodes retrieve passages (full-text search)
   and replies cite their sources.
9. **Keep people in the loop**: Approval nodes pause a conversation until someone approves in the **Inbox**; Handoff
   nodes pass it to your team with a transcript and summary; Form nodes ask the user for structured details.
10. **Stay safe**: Guardrail nodes catch personal data, prompt-injection attempts and blocked topics; tool and document
    content is marked as untrusted data in prompts.
11. **Test before you ship**: the **Eval studio** runs datasets against the draft in a sandbox (write tools simulated) with
    contains / outcome / LLM-judge checks; an optional **publish gate** blocks publishing until evals pass.
12. **Review before live**: optionally require a reviewer to approve a version (with a visual diff) before it goes live.
13. **Prove ROI**: the **Analytics** dashboard shows conversations, automation rate, hours and money saved against your
    human baseline, AI cost and satisfaction from widget thumbs-up/down.
14. **Control cost**: monthly AI budgets (dollars or tokens) stop model calls when reached.
15. **Reach customers anywhere**: the website widget, plus Slack, Microsoft Teams and WhatsApp channels per flow.
16. **Charge for it**: Stripe Checkout, customer portal and webhooks, with monthly conversation limits per plan (when Stripe is configured).
17. **Orchestrate several agents**: a **Supervisor** delegates to specialist agents (as tools) and writes the final answer;
    **Parallel** asks several agents at once; **Loop** repeats steps for each item in a list.
18. **Run in the background**: start flows on a **schedule** (cron, UTC) or from a signed **webhook**; **Wait** nodes pause
    a run for minutes or until a date and resume automatically.
19. **Remember customers**: **Memory** nodes recall, save or extract (with a model) facts about signed-in end users;
    admins can look up and erase a customer's data in Settings.
20. **Govern it**: an **Audit log** of every configuration change (CSV export), **data retention** (delete after N days)
    and **zero-retention** mode (no prompts, tool data or transcripts stored).
21. **Improve it**: **conversation insights** on the Analytics page group customers' questions by topic and flag problem
    topics with a suggested fix; **A/B test** two published versions on a share of traffic and promote the winner.
22. **Edit together**: see who else has a flow open, leave comments on nodes, and get a warning instead of silently
    overwriting someone else's save.
23. **WordPress**: a plugin in `integrations/wordpress/agentflow` adds the widget (bubble or `[agentflow]` shortcode) and
    signs in logged-in WordPress users.
24. **Deterministic context rules**: every AI step (Agent, Supervisor and its specialists, Parallel tasks) can have
    YAML rules (`when`/`else`, `switch`/`cases`, `first`, `title`). They are evaluated from variables without
    AI, so only the matching context reaches the model. The editor checks rules as you type and previews the exact
    context for sample values, and each run records which rules matched.

## Packages

| Path                         | What it is                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/builder`               | Next.js builder: canvas editor, test console, templates, connectors, runs & traces, deploy, settings |
| `apps/api`                   | Fastify API: auth, workspaces, flows, publish/versions, runs (SSE), connectors, templates, widget    |
| `apps/worker`                | Background worker (database heartbeat; schedules, timers and retention run in the API for now)       |
| `packages/flow-schema`       | Zod flow schema (`schemaVersion: 1`) and graph/formula validator                                     |
| `packages/expression-engine` | Sandboxed formula language and `{{ }}` / `{{#if}}` templates                                         |
| `packages/llm-gateway`       | Provider adapters, retries, fallback, structured output, cost; local mock model                      |
| `packages/mcp-client`        | MCP connection pool and tool calls; demo "orders" MCP server                                         |
| `packages/runtime`           | Graph executor, node handlers, run store, PII redaction                                              |
| `packages/templates`         | The outcome templates                                                                                |
| `packages/widget`            | Embeddable chat widget (web component, Shadow DOM, ~5 KB gzipped)                                    |
| `packages/db`                | Drizzle schema, migrations, seed, embedded Postgres dev server                                       |
| `packages/secret-store`      | AES-256-GCM encryption for keys and credentials                                                      |
| `packages/ui`                | Design tokens (light/dark) and base components                                                       |
| `integrations/wordpress`     | WordPress plugin that embeds the widget and signs in WordPress users                                 |

## Run it locally (no Docker needed)

Requires Node 22+. pnpm comes through corepack, which ships with Node, so you don't need to install it. Run `corepack enable` once
(as admin) to type `pnpm` directly; otherwise prefix commands with `corepack`.

```bash
corepack pnpm install
```

```bash
cp .env.example .env
```

Fill in `AUTH_SECRET`, `API_JWT_SECRET` and `SECRETS_MASTER_KEY` in `.env`; each is 32 random bytes in base64:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Start Postgres in its own terminal (an embedded server on port 5433, data in `.data/pg`):

```bash
corepack pnpm db:start
```

Create the tables and demo data (demo user, a mock-model key, the demo connector and a runnable "Order support" flow):

```bash
corepack pnpm db:migrate
```

```bash
corepack pnpm db:seed
```

In another terminal, start the free local mock model (port 4010) and demo orders MCP server (port 4020):

```bash
corepack pnpm demo
```

Then start the builder (http://localhost:3100), API (http://localhost:4000), worker and widget build:

```bash
corepack pnpm dev
```

Sign in with **Dev login**, open **Flows → Order support**, click **▶ Test** and ask "Where is my order 1042?".
For Phase 2, open **Refund assistant**: ask "How long does shipping take?" (cited answer), then "I want a refund" and
approve it in the **Inbox**.
For Phase 3, create a flow and drag in a **Supervisor**, **Loop** or **Wait** node; select **Start** to add a schedule or
a webhook.
Then **Publish**, open **Deploy → Live preview**, and chat with the embedded widget.

To use a real model, add a key in **Settings** (Anthropic, OpenAI, Azure OpenAI or OpenAI-compatible) and pick it on
each AI Agent node.

### With Docker instead

```bash
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

## Checks

```bash
corepack pnpm lint
```

```bash
corepack pnpm typecheck
```

```bash
corepack pnpm test
```

API tests are integration tests against the Postgres in `DATABASE_URL` (they start their own mock model and MCP server,
create their own users/org and delete them afterwards) and are skipped when `DATABASE_URL` is unset.
CI (`.github/workflows/ci.yml`) runs format, lint, typecheck, migrations, tests and build.

## How the pieces talk

- The builder signs users in with Auth.js and mints a 5-minute HS256 JWT for each API call (`apps/builder/src/lib/api.ts`).
  Client components use the same-origin proxy at `/api/v1/*`, which adds that token.
- The API checks workspace membership and role (owner > admin > builder > reviewer > viewer) per request.
- Runs execute in-process (`packages/runtime`, behind the `RunExecutor` interface). State and a trace step are saved
  after every node, so chats continue across messages. Events stream as server-sent events over the same POST request.
- The widget calls the public `/v1/widget/:key/*` endpoints. These check the page's origin against the flow's allowed
  websites (only localhost while that list is empty), rate-limit requests, bind each session with a signed token, and can
  verify a host-signed identity JWT for `{{user.*}}`.
- Background work runs on a timer inside the API (every 20 s): approvals past their deadline, Wait nodes whose time has
  come, schedules due this minute (each fires once per minute, tracked per flow), and hourly retention clean-up.
  It sits behind plain functions in `apps/api/src/automation.ts` so it can move to the worker or a queue later.
- Webhooks: `POST /v1/hooks/:key` with a JSON body; signed hooks need `x-agentflow-signature: sha256=<hex HMAC>`.
  `?wait=true` returns the run's End output; otherwise the API answers 202 with the run id.

## Notes

- **Move the repo out of OneDrive if you can** (e.g. `C:\dev\agentflow`). OneDrive touching files makes dev servers restart
  spuriously; the API/worker watch only `src` and `packages/` to limit this.
- Port 3100 is used for the builder (3000 is often taken by other local projects).
- `ALLOW_PRIVATE_HTTP=true` (dev only) lets HTTP nodes and connectors reach localhost; in production those requests are blocked.
- Changing the schema: edit `packages/db/src/schema`, then run `corepack pnpm db:generate` and `corepack pnpm db:migrate`.
- Scalability work is deliberately deferred (see `docs/03-architecture.md` §10); interfaces are kept so it can be added later.
