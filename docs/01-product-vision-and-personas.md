# 01 — Product Vision & Personas

## 1. Vision

> **"Every business process that today needs a person reading, deciding and typing can be handed to a team of AI agents — designed visually, connected to real data, trusted, and measured."**

AgentFlow is the Salesforce Flow Builder for the AI‑agent era: a no/low‑code canvas where business teams compose multiple specialised agents, wire them to company systems through MCP, and deploy them anywhere their customers or employees are.

## 2. The problems customers face today

| # | Pain | Evidence in the market | How AgentFlow solves it |
|---|---|---|---|
| P1 | **Support teams are overloaded**; 50–70% of tickets are repetitive (order status, password, policy) | Rising cost per ticket, long first‑response times | Support‑deflection template + RAG on help docs + Zendesk/Shopify MCP, with human handoff |
| P2 | **Chatbots are dumb** — scripted trees, can't look anything up or take action | Low CSAT on legacy bots | Agents call real tools (order lookup, refund, booking) via MCP |
| P3 | **Custom AI agents need engineers** — weeks of code per use case | AI backlogs in every IT team | Visual builder, templates, AI flow generator |
| P4 | **Nobody trusts agent output** — hallucinations, wrong actions | AI pilots stuck in "pilot purgatory" | Eval studio + publish gate, guardrails, human approval for write actions |
| P5 | **Can't prove ROI** — leadership asks "what did we get?" | Budget cuts on unmeasured AI | ROI dashboard: deflection, hours saved, cost vs. baseline |
| P6 | **Locked into one AI vendor** | Price / capability changes monthly | Pluggable models, BYOK, fallback routing |
| P7 | **Unpredictable AI spend** | Surprise invoices | Budgets, cost per conversation, cheap‑model routing, caching |
| P8 | **Data is scattered** across CRM, helpdesk, docs, databases | Agents answer generically | MCP connector hub + knowledge sync + per‑user memory |
| P9 | **Agents only chat; real work happens in back office** | Manual invoice/email processing | Proactive/background agents on schedules and events |

## 3. Ideal Customer Profile (ICP)

**Beachhead:** Mid‑market (100–2,000 employees) **B2C e‑commerce and B2B SaaS** companies with a support or sales team of 10–200 people, already using tools like Zendesk / Freshdesk / Intercom, HubSpot / Salesforce, Shopify, Google Workspace / M365.

**Expansion:** Enterprises (IT helpdesk, HR, finance ops), BPOs/contact centres, and digital agencies (white‑label resellers).

## 4. Personas

### 4.1 Priya — Head of Customer Support (Economic buyer)
- **Goal:** cut cost per ticket and response time without hurting CSAT.
- **Fears:** a bot that angers customers or gives wrong refunds.
- **Needs from AgentFlow:** templates, human handoff, guardrails, **ROI dashboard** to show her VP.
- **Success:** 40%+ tickets resolved by AI in 30 days, CSAT stable or up.

### 4.2 Rahul — Ops / Automation Specialist (Primary builder)
- **Goal:** build and iterate agents without waiting on engineering.
- **Skills:** comfortable with Zapier/Salesforce Flow; not a developer.
- **Needs:** intuitive canvas, variables & conditions, prompt editor with autocomplete, test console, version history.
- **Success:** ships a new flow in a day, fixes issues from traces himself.

### 4.3 Sara — Developer / Solutions Engineer (Technical builder)
- **Goal:** connect internal systems and embed the agent in the product.
- **Needs:** MCP connector hub (bring any MCP server), REST/SSE API, SDKs, signed user identity, webhooks, environments.
- **Success:** integration done in hours, not sprints.

### 4.4 Vikram — CTO / Security Lead (Gatekeeper)
- **Goal:** approve AI without creating risk.
- **Needs:** RBAC, SSO, audit logs, PII redaction, tool permissions, data‑retention controls, model choice (incl. Azure/private).
- **Success:** passes security review; no data incidents.

### 4.5 Neha — Sales Leader (Second buyer)
- **Goal:** more qualified meetings from website traffic.
- **Needs:** lead‑qualification template, CRM write‑back, calendar booking, conversion metrics.

### 4.6 Arjun — Agency Owner (Channel partner)
- **Goal:** sell AI agents to many SMB clients under his brand.
- **Needs:** white‑label, sub‑accounts, templates he can clone, rebilling.

### 4.7 End user — the website visitor / employee
- **Goal:** get an accurate answer or action done fast, or reach a human easily.
- **Needs:** fast, friendly widget, remembers context, clear handoff.

## 5. Top use cases (launch templates)

| Use case | Agents in the flow | Connectors | Outcome metric |
|---|---|---|---|
| **L1 Support deflection** | Triage → Knowledge answerer → Action agent → Handoff | Zendesk, help‑centre docs | Deflection %, CSAT |
| **Order status & returns** | Intent → Order lookup → Returns policy agent → Approval (refund > $X) | Shopify, Stripe | Resolved w/o human |
| **Lead qualification & booking** | Greeter → BANT qualifier → CRM writer → Calendar booker | HubSpot/Salesforce, Google Calendar | Meetings booked |
| **IT / HR helpdesk** | Router → Policy RAG agent → Ticket creator | Jira/ServiceNow, SharePoint | Tickets avoided |
| **Invoice processing (background)** | Extractor → Validator → ERP poster → Exception approval | Email/Drive, ERP/DB | Hours saved |
| **Churn‑risk alerts (scheduled)** | Data puller → Risk scorer → Account‑manager notifier | CRM, product DB, Slack | Saved accounts |

## 6. Value proposition (one‑liners)

- *For support leaders:* "Resolve half your tickets with AI agents that look things up and take action — and show the savings."
- *For builders:* "Design multi‑agent workflows like Salesforce Flow, connect any data via MCP, and ship in a day."
- *For security:* "Choose your model, control every tool, audit every step."

## 7. Product principles

1. **Outcome first** — every feature should move a customer metric (deflection, conversion, hours saved).
2. **Visual, but never a toy** — anything visible on the canvas is exactly what runs.
3. **Trust by default** — test before publish; humans approve risky actions; every step is traceable.
4. **Open** — open standards (MCP), any model, embed anywhere.
5. **Progressive complexity** — a template works in minutes; power users get formulas, subflows and supervisors.
