# AgentFlow — Planning Docs

> A visual, Salesforce‑Flow‑style builder for **multi‑agent AI workflows** with **MCP data connections**, pluggable LLMs (Claude, GPT, Azure OpenAI, any BYO model), and **one‑line embedding on any website**.

## Executive summary

**Problem.** Companies want AI agents that actually *do work* — resolve support tickets, qualify leads, process invoices — but today they must choose between rigid chatbots or expensive custom engineering. Agents are hard to connect to business data, hard to trust, and hard to prove ROI on.

**Solution.** AgentFlow lets a business user drag AI agents onto a canvas, write each agent's prompt, pass variables between them, branch on conditions, plug in live data through MCP connectors, test it, and publish it to any website with a `<script>` tag.

**Why it wins.**
1. **Model‑neutral** — Claude, GPT, Azure OpenAI, Bedrock, or any OpenAI‑compatible model; customers bring their own keys.
2. **Outcome templates** — go live in minutes with support‑deflection, lead‑qualification, order‑status and other ready flows.
3. **Trust built in** — evaluation studio with publish gates, step‑level tracing, guardrails, human approval for risky actions.
4. **Proves ROI** — dashboard showing deflection rate, hours saved and cost vs. human baseline.
5. **Embed anywhere** — Shadow‑DOM web component, SDKs, and channels (Slack, WhatsApp, email).

**Current target:** a **good working prototype** (TypeScript, Docker Compose). Scalability / high‑traffic handling is a **deferred upgrade**; the architecture keeps clean interface seams so that upgrade won't break anything.

## Document index

| # | Document | What's inside |
|---|---|---|
| 1 | [01-product-vision-and-personas.md](01-product-vision-and-personas.md) | Problem, ICP, personas, top use cases, value proposition |
| 2 | [02-feature-spec.md](02-feature-spec.md) | Node types, variables & formula grammar, MCP hub, widget, H1–H12, acceptance criteria |
| 3 | [03-architecture.md](03-architecture.md) | System diagram, services, data model, flow JSON schema, runtime semantics, deferred scale seams |
| 4 | [04-ux-wireframes.md](04-ux-wireframes.md) | Builder, properties panel, debug console, eval studio, ROI dashboard, approval inbox |
| 5 | [05-roadmap-and-backlog.md](05-roadmap-and-backlog.md) | Phases → epics → user stories, estimates, dependencies |
| 6 | [06-go-to-market-and-pricing.md](06-go-to-market-and-pricing.md) | Pricing tiers, competitor matrix, launch plan |
| 7 | [07-security-and-compliance.md](07-security-and-compliance.md) | Threat model (OWASP LLM Top 10), data flows, compliance roadmap |
| 8 | [08-integrations-setup.md](08-integrations-setup.md) | Setting up and testing Bedrock, Vertex, Slack, Teams, WhatsApp and Stripe with real credentials |

## Glossary

| Term | Meaning |
|---|---|
| **Flow** | A visual graph of nodes (agents, decisions, tools…) that runs as one workflow |
| **Node** | One step in a flow (AI Agent, Decision, MCP Tool, etc.) |
| **Run** | One execution of a flow (e.g. one conversation or one scheduled job) |
| **Variable** | A typed value passed between nodes, referenced as `{{name}}` |
| **MCP** | Model Context Protocol — open standard for connecting AI to tools & data |
| **Connector** | A configured MCP server (or REST API) with credentials |
| **Template** | A ready‑made flow + setup wizard for a business outcome |
| **Eval** | Automated test run of a flow against a dataset with scoring |
| **Outcome tag** | Label set at the end of a run (resolved / escalated / converted / failed) used for ROI |
| **H1–H12** | The twelve high‑impact capabilities (see feature spec §6) |
