# 06 — Go-to-Market & Pricing

## 1. Positioning

> **AgentFlow: build AI agent teams visually, connect them to your business data with MCP, and put them on any website. Model-neutral, testable, and measured in dollars saved.**

**Category:** Visual multi-agent orchestration platform (agent builder).
**Primary buyer:** Head of Support / CX, then Sales and Ops leaders.
**Primary user:** Ops or automation specialist (no-code), helped by a developer for integrations.

## 2. Competitive landscape

| Capability | **AgentFlow** | Salesforce Agentforce | Microsoft Copilot Studio | n8n | Flowise / Langflow | Voiceflow |
|---|---|---|---|---|---|---|
| Visual multi-agent canvas | ✅ Flow-style, supervisor/parallel | ✅ (inside Salesforce) | ✅ topics/actions | ✅ general automation | ✅ dev-oriented | ✅ conversation design |
| Model choice / BYOK | ✅ any (Claude, GPT, Azure, OSS) | Limited | Mostly Azure OpenAI | ✅ | ✅ | Partial |
| MCP-native connectors | ✅ first-class, plus flows as MCP servers | Partial | Partial | Partial | Partial | ❌ |
| Embed on any website | ✅ one line, Shadow DOM | Salesforce-centric | Teams/M365-centric | ❌ (DIY) | Basic | ✅ |
| Eval studio + publish gate | ✅ built in | Partial | Partial | ❌ | ❌ | Partial |
| ROI dashboard | ✅ outcome-based | Partial | Analytics | ❌ | ❌ | Analytics |
| Human approval for tool actions | ✅ | ✅ | ✅ | ✅ | ❌ | Partial |
| Vendor lock-in | Low | High (Salesforce) | High (Microsoft) | Low | Low | Medium |
| Target user | Business + dev | Salesforce admins | M365 makers | Technical ops | Developers | Conversation designers |

**Where AgentFlow differs:** it is the only option that combines *business-friendly visual building*, *any model*, *MCP-native data*, *embed anywhere* and *built-in trust (evals and approvals) with ROI proof*, without tying the customer to Salesforce or Microsoft.

## 3. Pricing

| Plan | Price | For | Includes |
|---|---|---|---|
| **Free** | $0 | Try it | 1 live flow, 100 runs/month, 1 seat, community templates, AgentFlow branding on the widget |
| **Pro** | $99/month | Small teams | 5 live flows, 2,000 runs/month, 3 seats, all core nodes, MCP connectors, knowledge (100 MB), traces (30 days), remove branding |
| **Business** | $499/month | Pilots and mid-market | 25 live flows, 15,000 runs/month, 10 seats, **evals + publish gate, approvals and handoff, ROI dashboard, budgets**, staging environment, Slack/WhatsApp/Teams, traces (90 days) |
| **Enterprise** | Custom (from ~$2,500/month) | Larger orgs | Unlimited flows, SSO/SCIM, custom roles, audit log, retention controls, dedicated support, SLA, self-host option (P4) |
| **Agency** | $299/month + $49 per client workspace | Resellers | White-label, client sub-accounts, rebilling with markup (P4) |

**Usage:**
- Runs over the plan allowance cost $0.02–$0.05 each, depending on tier. Optionally, customers can choose **per resolved conversation** pricing ($0.40–$0.90), which aligns price with value.
- **LLM costs:** with BYOK the customer pays the provider directly. With platform credits, the provider cost passes through plus a 15% margin.

## 4. Go-to-market plan

### Phase A — Design partners (alongside MVP, weeks 6–12)
- Recruit **8–10 design partners** from the ICP (e-commerce and SaaS support teams). CriticalRiver customer relationships are a good first source.
- Offer free Business tier for 3 months in exchange for weekly feedback and a case study.
- Success metric: at least 5 partners live in production, each with at least 30% deflection.

### Phase B — Public launch (around week 18)
- Product Hunt / Hacker News launch, a template gallery as SEO landing pages ("AI agent for Shopify order status"), and an MCP community presence.
- Content: "ROI of AI support agents" calculator, playbooks, comparison pages.
- Self-serve funnel: sign up → template → embed. Target: first value within 15 minutes.

### Phase C — Sales-assisted mid-market and enterprise (after week 28)
- Outbound to support and CX leaders. Lead with the ROI dashboard and a security pack.
- Partnerships: helpdesk and CRM marketplaces (Zendesk, HubSpot, Shopify app stores), system integrators (including CriticalRiver's own services arm).

### Phase D — Agency channel (after week 36)
- White-label programme for digital agencies, with partner certification and a template revenue share.

## 5. Funnel metrics

| Stage | Metric | Target |
|---|---|---|
| Acquire | Sign-ups/month | 1,000 by month 6 after launch |
| Activate | % who publish a flow within 24 h | ≥ 35% |
| Value | % of active workspaces with ≥ 30% resolution rate | ≥ 50% |
| Convert | Free → paid | ≥ 6% |
| Retain | Logo churn (monthly) | ≤ 2.5% |
| Expand | Net revenue retention | ≥ 120% |

## 6. Launch checklist
- [ ] 5 launch templates polished, each with a demo video
- [ ] Docs site: quick start, node reference, formula reference, MCP guide, embed guide, API reference
- [ ] Security pack: architecture overview, data-flow diagram, subprocessors list, DPA template
- [ ] Pricing page + Stripe checkout
- [ ] Status page + support channel
- [ ] Case studies from 3 design partners
