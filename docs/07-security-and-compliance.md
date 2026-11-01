# 07 — Security & Compliance

> The prototype implements a **security baseline** (§3). Enterprise controls arrive in Phase 3. Compliance certifications are a roadmap item (§6).

## 1. Assets to protect
- **Customer secrets:** LLM provider keys, connector credentials (OAuth tokens, API keys), webhook secrets.
- **Customer data:** knowledge documents, conversation transcripts, end-user identities and memories, tool results such as orders and CRM records.
- **Configuration:** flows, prompts and tool permissions. Tampering with these could make agents take harmful actions.
- **Platform integrity:** tenant isolation, billing and usage data.

## 2. Data flows

```
End user ──(HTTPS, widget session token, optional identity JWT)──▶ API
API ──▶ Worker ──(HTTPS, customer's key)──▶ LLM provider (Anthropic / OpenAI / Azure / BYO)
Worker ──(HTTPS, OAuth/API key)──▶ Customer MCP servers & SaaS tools
Worker ──▶ Postgres (encrypted secrets, PII-redacted traces) · Redis (ephemeral) · File store (documents)
Builder user ──(HTTPS, session JWT)──▶ API
```
- Data sent to an LLM provider goes **only** to the provider the customer configured for that agent.
- With BYOK, provider data-use terms are the customer's own (for example, Azure OpenAI customers keep data in their own tenant).

## 3. Prototype security baseline

| Control | Implementation |
|---|---|
| Transport | HTTPS everywhere (TLS terminated at the reverse proxy in hosted demos) |
| Auth (builder) | Auth.js sessions → short-lived JWT; role checks in API middleware |
| Tenant isolation | `workspace_id` filter enforced in the repository layer + Postgres RLS policies |
| Secrets at rest | AES-256-GCM via `SecretStore`, master key from env; secrets are write-only in the UI |
| Secrets in prompts | Validation blocks `{{secret.*}}` in prompt templates; secrets usable only in tool/HTTP config |
| Widget | Origin allow-list, per-session token, per-session/IP rate limit, CSP-friendly loader |
| End-user identity | Host-signed JWT (HS256/RS256) verified on session start |
| Tool safety | Per-agent allow-list enforced server-side; max tool calls per agent turn; idempotency keys on write tools |
| PII | Regex-pack redaction before traces are stored (email, phone, card + Luhn, Aadhaar, PAN, SSN, IBAN) |
| Prompt-injection | Heuristic scan of tool/RAG output; untrusted content wrapped in delimiters and labelled as data in the system prompt |
| Run limits | Max steps, max cost, and loop caps per run |
| Webhooks | HMAC-SHA256 signature verification with timestamp tolerance |
| stdio MCP | Allowed only in self-run/dev mode; launched with a restricted env and working directory |
| Logging | Structured logs without secrets or raw PII |

## 4. Threat model — OWASP Top 10 for LLM applications

| # | Risk | Where it applies | Mitigations |
|---|---|---|---|
| LLM01 | **Prompt injection** (direct and indirect via documents or tool output) | Agent nodes, Knowledge, MCP results | Injection heuristics; untrusted-content delimiters; tool allow-lists; approval for write tools; Guardrail node; evals with attack datasets |
| LLM02 | **Sensitive information disclosure** | Responses, traces | PII redaction; secrets never in prompts; output guardrails; per-workspace isolation; retention controls (P3) |
| LLM03 | **Supply chain** (malicious MCP servers or templates) | Connector Hub, marketplace | Curated connectors; HTTPS-only remote MCP; tool classification; marketplace review (P4); version pinning |
| LLM04 | **Data and model poisoning** | Knowledge sources, memory | Source ownership per workspace; re-sync with hashes; memory facts reviewed and expiring; end-user deletion |
| LLM05 | **Improper output handling** | Widget rendering, tool args | Widget sanitises markdown (no raw HTML); tool args validated against JSON schema; formulas sandboxed (no eval) |
| LLM06 | **Excessive agency** | Tool calls, background agents | Least-privilege tool lists; read/write/destructive classes; human approval; budgets and step caps; sandbox mode in evals |
| LLM07 | **System prompt leakage** | Agent prompts | No secrets in prompts (validated); output guardrail can block prompt echoing |
| LLM08 | **Vector and embedding weaknesses** | RAG | Per-workspace filtering on every vector query; no cross-tenant indexes |
| LLM09 | **Misinformation / hallucination** | Answers | Citations; "answer only from sources" templates; LLM-judge evals; low-confidence → handoff |
| LLM10 | **Unbounded consumption** | LLM calls | Budgets, per-run cost caps, rate limits per widget session, response cache |

**Classic web risks** (OWASP Top 10) are covered by: parameterised queries (Drizzle ORM), CSRF protection on builder forms, strict CORS for builder APIs, dependency scanning in CI, and security headers.

## 5. Roles and permissions (P1 basic → P3 custom)

| Action | Owner | Admin | Builder | Reviewer | Viewer |
|---|---|---|---|---|---|
| Manage billing, SSO, delete org | ✅ | | | | |
| Manage members, provider keys, connectors | ✅ | ✅ | | | |
| Create and edit flows, prompts, knowledge | ✅ | ✅ | ✅ | | |
| Approve review / publish to Live | ✅ | ✅ | ⚙️ (setting) | ✅ | |
| Decide approvals in inbox | ✅ | ✅ | ⚙️ (if assigned) | ✅ | |
| View runs, traces, analytics | ✅ | ✅ | ✅ | ✅ | ✅ |

## 6. Compliance roadmap

| Item | Phase | Notes |
|---|---|---|
| Privacy policy, DPA template, subprocessor list | P2 | Needed for paid pilots |
| GDPR / India DPDP: access, deletion, export of end-user data | P2–P3 | End-user deletion purges messages, memories and traces |
| Data retention policies, zero-retention mode | P3 | Per-workspace settings |
| Audit logging | P3 | Config changes, approvals, logins |
| SSO/SAML, SCIM | P3 | Enterprise requirement |
| SOC 2 Type I → Type II | P3 → P4 | Control map below |
| ISO 27001 readiness | P4 | Optional, depends on market demand |
| Data residency | Later | Part of the deferred scalability upgrade (Arch §10) |

### SOC 2 control map (starter)

| Trust criterion | Example controls in AgentFlow |
|---|---|
| CC6 Logical access | RBAC, SSO, MFA via IdP, least privilege, quarterly access review |
| CC7 System operations | Centralised logging, alerting, incident response runbook |
| CC8 Change management | PR reviews, CI tests, protected main branch, versioned flows with review gate |
| CC9 Risk mitigation | Vendor (LLM provider) assessments, subprocessor list |
| C1 Confidentiality | Encryption at rest/in transit, secret handling, retention controls |
| PI1 Processing integrity | Evals and publish gates, idempotent tool calls, run tracing |

## 7. Secure development practices
- Dependency and secret scanning in CI; signed container images.
- A threat-model review for every new node type or connector class.
- Red-team eval datasets (prompt-injection and jailbreak cases) run before each release.
- Responsible disclosure policy and security contact.
