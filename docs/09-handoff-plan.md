# AgentFlow — handoff and pending work

Written 2026-11-01 so a new session can continue without the previous conversation. Read this first, then
`README.md`, then the docs it points to.

## 1. Where things stand

- **Built:** Phases 0–2 in full (account-based integrations are tested only against local fakes) and the **Phase 3
  core**. See `README.md` §"What you can do" and the status block under Phase 3 in `docs/05-roadmap-and-backlog.md`.
- **Repo:** private GitHub repo `dev-ankit08/Agentflow`, branch `main`, first commit `f805b15`. CI (format, lint,
  typecheck, migrations, tests, build) **passed** on GitHub.
- **Checks on 2026-11-01:**
  - 156 tests pass (API 41, runtime 25, flow-schema 19, expression engine 40, gateway 16, templates 6, secret store 5,
    MCP 4).
  - Lint, typecheck, Prettier and the production build are clean.
  - Phase 3 UI was verified by hand in the browser.
- **Not verified:**
  - The WordPress plugin (no PHP on this machine).
  - Real Bedrock, Vertex, Slack, Teams, WhatsApp and Stripe accounts.
- **Scope rule from the owner:** this is a working prototype. Scalability and high-traffic work are deliberately
  deferred to a later upgrade. Don't add Redis, queues, Temporal and so on unless asked, and keep the existing
  interfaces (`RunExecutor`, `RunStore`, `LLMProvider`) so that upgrade stays possible.

## 2. Working rules for the next session (important)

1. **No AI attribution anywhere in git.** No `Co-Authored-By`, no "Generated with" lines in commits or PRs. Commits use
   the owner's own git identity only.
2. **Don't commit or push unless the owner asks.** Branch first for new work (`main` is the default branch).
3. **Environment:**
   - Windows, Node 24, and the repo lives in OneDrive (`Desktop\agentflow`).
   - Use `corepack pnpm …` (pnpm isn't installed globally).
   - Docker isn't installed.
4. **Ports:**
   - 3100: builder (3000 belongs to another project).
   - 4000: API.
   - 5433: embedded Postgres.
   - 4010: mock LLM.
   - 4020: demo MCP server.
5. **Start order** (each in its own terminal / background task):
   1. `corepack pnpm db:start`
   2. `corepack pnpm demo`
   3. `corepack pnpm dev`

   Sign in with **Dev login**.
6. **Building the builder while `pnpm dev` runs breaks the dev server.** Next.js shares `.next`, and you'll see
   "Jest worker … exceeding retry limit". To avoid it:
   1. Stop dev.
   2. Make sure port 3100 is free. Stopping the task can leave the `next` child running; kill its PID from
      `Get-NetTCPConnection -LocalPort 3100`.
   3. Build.
   4. Delete `apps/builder/.next`.
   5. Restart dev.
7. **Schema changes:**
   1. Edit `packages/db/src/schema/*`.
   2. Run `corepack pnpm db:generate`.
   3. Run `corepack pnpm db:migrate` (migrations 0000–0006 exist).
8. **OneDrive:** it causes spurious restarts of the API watcher. Wait for `GET localhost:4000/health` before testing.
9. **Shell quoting:** heredocs with quotes or backticks often break in the bash tool here. Use the Edit tool, or write a
   small `.mjs` script to the scratchpad and run it with node.
10. **Before handing work back, run the full checks:**
    - `corepack pnpm format`
    - `corepack pnpm lint`
    - `corepack pnpm typecheck`
    - `corepack pnpm test` (the API tests need Postgres running)
    - `corepack pnpm build`

## 3. Code map (where to change things)

| Area | Location |
|---|---|
| Flow JSON schema, node configs, validator, cron | `packages/flow-schema/src/{schema,validate,cron}.ts` |
| Node handlers | `packages/runtime/src/handlers.ts` (Phase 0–2), `handlers-orchestration.ts` (Supervisor, Loop, Parallel, Wait, Memory) |
| Executor (pause/resume, step limits) | `packages/runtime/src/executor.ts` |
| Run store (incl. zero-retention scrubbing) | `packages/runtime/src/stores.ts` |
| Runtime types | `packages/runtime/src/types.ts` |
| LLM providers | `packages/llm-gateway/src/providers/*` |
| DB tables | `packages/db/src/schema/{auth,core,flows,phase2,phase3}.ts` |
| API wiring, background sweep | `apps/api/src/app.ts` |
| Schedules, timers, retention, memory, A/B choice | `apps/api/src/automation.ts` |
| Audit hook, audit/end-user/insights routes | `apps/api/src/routes/governance.ts` |
| Triggers, webhooks, A/B, presence, comments | `apps/api/src/routes/automation-routes.ts` |
| Editor | `apps/builder/src/components/editor/*` (`model.ts` = palette, defaults, variable hints; `inspector*.tsx` = forms) |
| Builder pages | `apps/builder/src/app/(app)/*`; server actions in `app/actions*.ts` |
| Widget | `packages/widget/src/index.ts` |
| WordPress plugin | `integrations/wordpress/agentflow/` |

## 4. Pending work — prioritised plan

Estimates are rough engineering days for this codebase.

### P0 — Verify what exists (do first, ~1–2 days)

1. **WordPress plugin test.**
   1. Run WordPress locally (wp-env, LocalWP or XAMPP) with PHP 7.4+.
   2. Install `integrations/wordpress/agentflow`.
   3. Set the API URL, widget key and identity secret.
   4. Add the WP origin to the flow's allowed websites.

   Done when the bubble and `[agentflow]` shortcode render, and a logged-in user appears as `wp_<id>` in runs and
   Memory. Run `php -l` on the plugin.
2. **Real-credential integrations.** Follow `docs/08-integrations-setup.md` for Bedrock, Vertex, Slack, Teams, WhatsApp
   and Stripe (each needs a public URL, e.g. ngrok/cloudflared). Fix any adapter differences found.
3. **End-to-end test (T-5) — done** on branch `e2e-and-leftovers`.
   - `apps/builder/e2e/template-to-widget.spec.ts`: dev login → install Lead Qualification → publish → chat in
     `/preview/[key]` → check for a new reply.
   - Run it with `corepack pnpm --filter @agentflow/builder e2e` while the dev stack is up. It uses the installed Edge
     browser; `E2E_CHANNEL=""` switches to bundled Chromium.
   - In CI it is the opt-in `e2e` job: start it from the Actions tab, or set the repository variable `RUN_E2E=true`. It
     has not run on GitHub yet.
   - It found a real bug, now fixed: the Lead Qualification template had a node named `score` that hid the `score`
     variable, so every installed copy failed on its first message. The validator now rejects node ids that clash with
     variable names. Copies installed before the fix need their "Total score" node renamed (e.g. to `total`).

### P1 — Finish partly built Phase 2–3 items (~10–14 days)

4. **Semantic retrieval (K-1/K-2) — done** on branch `e2e-and-leftovers`.
   - Gateway: `LLMGateway.embed()`, batches of 64, with embeddings for OpenAI, Azure OpenAI, OpenAI-compatible
     servers and the mock model (`mock-embed`, also served by the mock server at `/v1/embeddings`).
   - DB: `chunks.embedding` (`real[]`) and `chunks.embedding_model` (migration 0007). The workspace setting is
     `settings.embedding`.
   - `apps/api/src/semantic.ts` holds `indexKnowledge`, `indexStatus` and hybrid `searchKnowledge`. Search fuses
     full-text and cosine rankings with reciprocal rank fusion (vectors are compared in the API process), and falls
     back to full-text if embedding fails.
   - New passages are indexed on add and re-sync, and the API background sweep indexes anything pending (e.g. after
     the model changes).
   - Settings → "Semantic knowledge search" picks the model and shows progress, with an "Index now" button.
   - API: `GET` and `POST /v1/knowledge/index`.
   - **Still open:**
     - Bedrock and Vertex embeddings.
     - pgvector for large knowledge bases.
     - Reusing the embedder for insights clustering (IN-1, still keyword-based in `clusterQuestions`) and for the
       semantic cache (C-3).
5. **Memory background extraction (MEM-1) — done** on branch `e2e-and-leftovers`.
   - `extractMemories` in `apps/api/src/automation.ts` runs in the API sweep. For workspaces with
     `settings.memoryExtraction.enabled`, it finds live conversations with a signed-in end user that have been quiet
     for `idleMinutes` (default 30). It extracts facts with the shared `extractFacts` (runtime; also used by the
     Memory node) and writes them to memory, de-duplicated.
   - Each run gets `runs.memory_extracted_at` (migration 0008), so it is processed again only if the conversation
     continued.
   - Workspaces over their AI budget are skipped. A failing model is not retried until the conversation continues.
   - Settings → "Customer memory" turns it on and picks the model and idle time.
   - **Still open:** extraction cost is not added to the run's cost or the monthly usage figures.
6. **More triggers (TR-1) — done in part** on branch `e2e-and-leftovers`. All of it is in `hookRoutes` in
   `apps/api/src/routes/automation-routes.ts` and the Start node's `TriggersPanel`.
   - **Inbound email:** `POST /v1/inbound/email/:key` (address created with `POST /v1/flows/:id/email-hook`). It
     accepts Postmark JSON, Mailgun form fields or plain JSON. The text is `trigger.message`, plus
     `trigger.email.{from,to,subject,text}`, and runs get trigger type `email`.
   - **File drop:** `POST /v1/hooks/:key/file` with the file as the raw body (text, CSV or JSON; name in `x-filename`).
     It gives `trigger.file` and, for CSV, `trigger.rows` (parsed by `parseCsv`).
   - **CRM events:** the webhook can verify HubSpot v3 signatures using the HubSpot app's client secret.
   - **Batch mode:** a webhook option (`PATCH /v1/flows/:id/webhook`) where a JSON array or CSV file starts one run
     per item (up to 500), with `batchIndex` and `batchSize` in the trigger. `?wait=true` returns every run's result.
   - **Still open:**
     - Multipart uploads (SendGrid inbound parse, browser form uploads) and PDF or Office text extraction.
     - Salesforce outbound messages and Platform Events.
     - Batch mode for schedules (use a Loop node meanwhile).
7. **Approval notifications (H-2).** Notify approvers of new Inbox items by email (SMTP via `nodemailer`, Mailpit for
   local testing) and by Slack interactive message if a Slack channel is connected. Approve/reject links use a signed
   token.
8. **Eval CSV import (V-1) and ROI CSV export (A-2).** Add a CSV upload on the evals dataset page and an export button
   on Analytics. Follow the pattern of the audit CSV export in `governance.ts`.
9. **Prompt library and prompt diff (P-1).** Save and reuse prompts per workspace, and show a side-by-side diff between
   versions (the version diff page already exists).
10. **Shopify (PL-1, rest).** Build a theme app extension that injects the widget script and passes the customer
    identity (signed by an app proxy).

### P2 — Deferred Phase 3 enterprise items (~20–25 days)

11. **SSO/SAML + SCIM (EN-1).**
    - Auth.js OIDC provider per org (Okta/Entra/Google), with SAML through a library such as `@boxyhq/saml-jackson`.
    - SCIM 2.0 `/scim/v2/Users|Groups` endpoints with a bearer token per org, mapping to `memberships`.
    - Settings UI: domain verification and "enforce SSO".
12. **Custom roles (EN-2).**
    - Today roles are fixed (owner > admin > builder > reviewer > viewer, `hasRole` in `apps/api/src/auth.ts`).
    - Add a `roles` table with permission sets (e.g. `flows.publish`, `keys.manage`, `inbox.decide`).
    - Replace `requireWorkspace(minRole)` with `requirePermission(perm)`, keeping the built-in roles as presets.
13. **Real-time co-editing (CO-1, rest).**
    - Add Yjs: a `y-websocket`-style endpoint on the API (Fastify websocket) and the editor's nodes and edges in a Y.Doc.
    - Keep autosave of the draft JSON.
    - Presence, comments and conflict detection already exist; the conflict banner becomes a fallback.
14. **Scheduled ROI email reports (A-3).** A weekly cron in the sweep renders the Analytics numbers to an HTML email
    sent to admins. Needs the SMTP from item 7.
15. **Semantic cache (C-3).** In the gateway, before calling the model, look up recent answers with the same flow,
    node and normalised prompt (exact match first, then embedding similarity over a threshold). Show cache hits in
    traces and add a per-agent opt-out.
16. **SharePoint + Confluence sources and reranking (K-4).** Microsoft Graph / Confluence REST connectors with
    scheduled re-sync (also the K-3 gap: Google Drive and Notion). Rerank with an LLM, or a cross-encoder when one is
    available.

### P3 — Phase 4, Ecosystem (from the roadmap)

17. **Template and connector marketplace (MP-1):** publish, review, rate and install.
18. **White-label / agency mode (WL-1):** partner → client org → workspace, branding, custom domains, rebilling. The DB
    needs a `partners` table and `orgs.partnerId`.
19. **Expose flows as MCP servers (MS-1):** a Streamable HTTP MCP endpoint per published flow, with the flow's Start
    inputs as the tool schema.
20. **AI flow generator (AI-1):** plain text → draft flow JSON, validated by `validateFlow` and repaired if invalid.
21. **Voice channel (VO-1):** WebRTC with STT/TTS.
22. **Self-host package (SH-1)** and **SOC 2 readiness (SOC-1).**

### Later — the scalability upgrade (explicitly deferred by the owner)

When asked:
- Move the background sweep (`apps/api/src/automation.ts`) into `apps/worker` with a queue.
- Make presence and the widget rate limiter shared (Redis) instead of in-memory.
- Swap `InProcessExecutor` for a durable engine behind `RunExecutor`.
- Move traces to an analytics store.
- Cache the zero-retention lookup in `DbRunStore` (today it runs one query per step).

See `docs/03-architecture.md` §3.7/§10.

## 5. Known limitations and small tech debt

- Background jobs (approvals, timers, schedules, retention) run on a 20 s timer **inside the API process**. Running
  more than one API instance would double-fire schedules unless they're moved or locked.
- Presence and the widget rate limiter are in-memory: they reset on restart and aren't shared across instances.
- Audit entries for "Created flow" have no target id (the id isn't in the route params). The API could record the
  response id instead.
- Insights cluster by keyword, not meaning. Results are rough for short or unusual wording.
- The A/B split is random per new conversation, not sticky per visitor.
- Supervisor workers can use connector tools, but the inspector has no UI yet to pick tools per worker
  (`workers[].tools` is in the schema).
- A Wait node in a chat flow returns 423 to the widget until it resumes. The widget polls the session for the
  follow-up reply.

## 6. Prompt to start the next session

> Continue the AgentFlow project in `Desktop\agentflow` (private repo dev-ankit08/Agentflow). Read
> `docs/09-handoff-plan.md` first and follow its working rules: no AI attribution in git, don't commit without
> asking, `corepack pnpm`, and the builder-build caveat. Start with item <N> from §4 and tell me your plan before
> coding.
