# 04 — UX & Wireframes

## 1. Design principles
1. **What you see is what runs.** The canvas is the single source of truth. No hidden logic.
2. **Progressive disclosure.** Simple fields come first. "Advanced" sections hold formulas, retries and schemas.
3. **Always testable.** The test console sits one click away on every screen that edits a flow.
4. **Explain the AI.** Every answer can be traced to its prompt, the data it used and the cost.
5. **Friendly defaults.** Templates, sensible model defaults, and starter prompts are pre-filled.

Visual style: clean neutral surfaces with one accent colour, rounded nodes colour-coded by category (AI = violet, Logic = amber, Data = teal, People = rose, Output = slate). Light and dark mode. Every interaction works from the keyboard.

---

## 2. App navigation

```
┌──────────┬──────────────────────────────────────────────────────────────┐
│ AgentFlow│  Workspace: Acme Support ▾                      🔔  ? (Ankit)│
├──────────┼──────────────────────────────────────────────────────────────┤
│ ▸ Home   │                                                              │
│ ▸ Flows  │                     (page content)                           │
│ ▸ Templates                                                             │
│ ▸ Connectors                                                            │
│ ▸ Knowledge                                                             │
│ ▸ Runs & Traces                                                         │
│ ▸ Evals  │                                                              │
│ ▸ Inbox (3)                                                             │
│ ▸ Analytics                                                             │
│ ▸ Settings                                                              │
└──────────┴──────────────────────────────────────────────────────────────┘
```

**Home** shows a "Get started" checklist (connect a model → install a template → test → embed), plus ROI cards and recent runs.

---

## 3. Flow builder (main screen)

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Order support   ● Draft v7   [Saved]          [▶ Test] [⎇ Versions] [Request review] [Publish]│
├──────────────┬───────────────────────────────────────────────────────┬────────────────────┤
│ 🔍 Search    │                                                       │ AI Agent: Triage   │
│ TRIGGERS     │   ┌────────┐    ┌──────────────┐    ┌───────────┐     │ ────────────────── │
│  ◯ Chat      │   │▶ Chat  │───▶│🤖 Triage      │───▶│◆ Route    │     │ Model              │
│  ◯ Webhook   │   └────────┘    │ claude-haiku  │    └─┬───┬───┬─┘     │ [Claude Haiku ▾]   │
│ AI           │                 └──────────────┘ status│ refund│ other │ Fallback [GPT ▾]   │
│  🤖 Agent     │                                       ▼   ▼   ▼       │                    │
│  🧭 Supervisor│                         ┌────────────┐ ┌──────────┐   │ System prompt      │
│ LOGIC        │                         │🔌 Get order │ │🙋 Handoff │   │ ┌────────────────┐ │
│  ◆ Decision  │                         └─────┬──────┘ └──────────┘   │ │Classify the    │ │
│  = Assignment│                               ▼                       │ │intent of {{tr… │ │
│  ⟳ Loop      │                         ┌────────────┐  ┌─────────┐   │ └────────────────┘ │
│  ⫴ Parallel  │                         │🤖 Answer    │─▶│■ Done   │   │ {{ autocomplete ▾}}│
│ DATA         │                         └────────────┘  └─────────┘   │ trigger.message    │
│  🔌 MCP Tool  │                                                       │ user.plan          │
│  📚 Knowledge │                                           [minimap]   │ triage.output.*    │
│  🌐 HTTP      │                                                       │                    │
│ PEOPLE       │                                                       │ Output schema  [+] │
│  ✋ Approval  │                                                       │ intent: enum       │
│  🙋 Handoff   │                                                       │ order_id: text     │
│ OUTPUT       │                                                       │ ▸ Tools (0)        │
│  ■ End       │                                                       │ ▸ Knowledge        │
│              │                                                       │ ▸ Advanced         │
├──────────────┴───────────────────────────────────────────────────────┴────────────────────┤
│ TEST CONSOLE  [Chat] [Timeline] [Variables]            Model cost this run: $0.004  1.8s   │
│ 👤 Where is my order #1042?                                                                 │
│ 🤖 Your order #1042 shipped yesterday and arrives Thursday. Tracking: …                     │
│ Timeline: ✓Chat ✓Triage(0.6s) ✓Route→status ✓Get order(0.3s) ✓Answer(0.9s) ✓Done(resolved)  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key interactions**
- Drag from the palette onto the canvas, or double-click the canvas to open a quick-add search.
- Hovering a node shows a "+" on its output handle to add and auto-connect the next node.
- Clicking an edge from a Decision shows its outcome label and condition.
- Nodes with validation errors show a red dot. The Publish button lists the issues.
- During a test, the path taken is highlighted on the canvas.

---

## 4. Properties panel variants

**Decision node**
```
Decision: Route
Outcomes (evaluated top → bottom)
 ┌ status ───────────────────────────────────────────┐
 │ [triage.output.intent ▾] [equals ▾] ["order_status"]│
 │ AND [triage.output.order_id ▾] [is not blank ▾]     │
 │                                  [Advanced formula] │
 └─────────────────────────────────────────────────────┘
 ┌ refund ─────────────────────────────────────────────┐
 │ [triage.output.intent ▾] [equals ▾] ["refund"]       │
 └─────────────────────────────────────────────────────┘
 [+ Add outcome]          Default outcome: [other]
```

**MCP Tool node**
```
MCP Tool: Get order
Connector  [Shopify (con_shopify) ▾]   ● connected
Tool       [get_order ▾]  read-only
Arguments
  order_id*  [ triage.output.order_id          ] fx
Requires approval  [ off ]
[Test tool with sample values]
```

**Assignment node**: rows of `[variable ▾] = [formula]`, each with a live preview.

**Variables panel** (opened from a canvas toolbar button): a table of name, type, default, input/output flags and description. Usage count links to the nodes that use each variable.

---

## 5. Connectors

```
Connectors                                              [+ Add connector]
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Shopify      │ Zendesk      │ HubSpot      │ Custom MCP   │
│ ● Connected  │ ● Connected  │ ○ Connect    │ + Add URL    │
│ 12 tools     │ 9 tools      │              │              │
└──────────────┴──────────────┴──────────────┴──────────────┘

Add custom MCP server
 Name        [Internal orders API     ]
 Transport   (•) Streamable HTTP  ( ) Local stdio (dev)
 URL         [https://mcp.acme.com/mcp]
 Auth        [Bearer token ▾]  [••••••••••]
 [Test connection]  → ✓ Discovered 6 tools, 2 resources
 Tools:  get_order (read) · update_address (write ☐ requires approval) · …
```

---

## 6. Templates gallery and install wizard

```
Templates   [All] [Support] [Sales] [Ops] [HR/IT]
┌────────────────────────┐ ┌────────────────────────┐ ┌────────────────────────┐
│ 🎧 L1 Support Deflection│ │ 📦 Order Status & Returns│ │ 🎯 Lead Qualify & Book │
│ Resolve FAQs + actions │ │ Shopify + refunds w/    │ │ BANT + CRM + calendar  │
│ Needs: Helpdesk, Docs  │ │ approval                │ │ Needs: CRM, Calendar   │
│ ⏱ ~10 min · 📈 40% defl.│ │ ⏱ ~15 min               │ │ ⏱ ~15 min              │
│ [Preview] [Use]        │ │ [Preview] [Use]         │ │ [Preview] [Use]        │
└────────────────────────┘ └────────────────────────┘ └────────────────────────┘

Wizard:  ① Connect Zendesk ✓ → ② Add help-centre URL → ③ Choose model → ④ Test → ⑤ Embed
```

---

## 7. Runs and trace detail

```
Run run_8f2a · Order support v7 · ✓ resolved · $0.004 · 1.8s · user: jane@…   [Replay from step ▾]
┌ Timeline ───────────────────────────┐ ┌ Step: Answer (AI Agent) ──────────────────────┐
│ 0.00s ✓ Chat (trigger)              │ │ Model: gpt-5 · in 412 tok · out 88 tok · $0.003 │
│ 0.02s ✓ Triage      0.6s  $0.0006   │ │ Prompt sent (PII redacted):                     │
│ 0.61s ✓ Route → status              │ │  System: You are a friendly support agent…      │
│ 0.62s ✓ Get order   0.3s            │ │  User: Question: Where is my order <ORDER_ID>…  │
│ 0.93s ✓ Answer      0.9s  $0.003    │ │ Output: "Your order shipped yesterday…"         │
│ 1.80s ✓ Done (resolved)             │ │ Variables after step ▸                          │
└─────────────────────────────────────┘ └────────────────────────────────────────────────┘
[Add to eval dataset]
```

---

## 8. Eval studio

```
Evals › Order support regression (48 cases)          Gate: ≥ 90% pass, no regression > 3%
[Run on Draft v8]   Last runs:  v7 ✓ 94%   v8 ✗ 86% (−8%)  ← blocks publish
┌────┬──────────────────────────────┬──────────┬────────┬────────┬───────┐
│ #  │ Input                        │ Judge    │ Schema │ Tool ok│ Pass  │
├────┼──────────────────────────────┼──────────┼────────┼────────┼───────┤
│ 12 │ "I want my money back for…"  │ 2/5      │ ✓      │ ✗      │ ✗     │
│ 13 │ "Where's #1043?"             │ 5/5      │ ✓      │ ✓      │ ✓     │
└────┴──────────────────────────────┴──────────┴────────┴────────┴───────┘
Click a row → side-by-side: expected vs actual, judge reasoning, trace link
```

---

## 9. Approval inbox

```
Inbox (3 pending)
┌─────────────────────────────────────────────────────────────────────────┐
│ 💸 Refund $640 for order #1042 · Order support · 4 min ago               │
│ Agent reasoning: "Item arrived damaged; photo attached; within 30 days." │
│ Customer: jane@… (VIP) · Conversation ▸                                  │
│                            [Reject]  [Edit amount]  [Approve ✓]          │
└─────────────────────────────────────────────────────────────────────────┘
```
The same card is sent to Slack with Approve and Reject buttons.

---

## 10. ROI dashboard

```
Analytics · Last 30 days · All flows ▾
┌────────────┬────────────┬────────────┬────────────┬────────────┐
│ Runs       │ Resolved   │ Hours saved│ Net savings│ CSAT       │
│ 12,480     │ 58% ▲6     │ 1,207 h    │ $18,940    │ 4.5 / 5    │
└────────────┴────────────┴────────────┴────────────┴────────────┘
[Resolution rate trend — line]          [Outcomes — stacked bar by flow]
Top unresolved topics (Insights): 1. Warranty claims (212, 61% escalated) [Fix ▸] …
Baseline: $6.00 per human ticket · 8 min AHT  [Edit]
```

---

## 11. Embed and deploy screen

```
Deploy · Order support (Live v7)
Channel:  [Website ✓] [Slack] [WhatsApp] [API]
Snippet:  <script src="https://cdn.agentflow.ai/w.js" data-flow="flw_abc123" async></script>  [Copy]
Allowed domains: acme.com, *.acme.com  [+]
Appearance: Mode (•) Bubble ( ) Inline ( ) Full page · Colour [#5B5BD6] · Logo [upload] · Welcome [Hi! …]
Identity: ☑ Require signed user token   Secret: [Reveal once]
[Live preview →]
```

---

## 12. Widget (end-user view)

```
┌──────────────────────────────┐
│ 🟣 Acme Assistant        — ✕ │
├──────────────────────────────┤
│ Hi Jane! How can I help?     │
│ [Track order] [Return item]  │
│            Where is #1042? 👤│
│ 🤖 Your order shipped        │
│ yesterday 📦 arriving Thu.   │
│ Source: Shipping policy ↗    │
│ 👍 👎                         │
├──────────────────────────────┤
│ Type a message…        [➤]   │
│        Talk to a human        │
└──────────────────────────────┘
```

---

## 13. Accessibility and responsiveness
- WCAG 2.1 AA contrast. Every canvas action has a keyboard path (Tab between nodes, Enter to edit, arrow keys to move).
- The widget works down to 320 px wide, supports screen readers through ARIA live regions, and respects `prefers-reduced-motion`.
- The builder is designed for desktop (≥ 1280 px). Dashboards and the inbox are responsive for mobile approvals.
