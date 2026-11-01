# 08 — Integrations: setup and testing with real credentials

These integrations are **built and tested against local fakes**, but have **not yet been run against the real services**
(no sandbox credentials were available). This guide lists what to create in each service, where to enter it in
AgentFlow, and how to check that it works.

| Integration | What is tested today | What to verify with real credentials |
|---|---|---|
| AWS Bedrock | Request format, SigV4 signing (matches AWS's published example), tool calls | A real Converse call and model access in your account |
| Google Vertex AI (Gemini) | Service-account token exchange, request format, streaming, function calls | Token exchange with Google and a real Gemini response |
| Slack | Signature checks, URL verification, threaded replies, multi-turn | Event delivery from your Slack app |
| Microsoft Teams | Bot Framework JWT checks (with a test key), replies through the connector | Microsoft's real signing keys and the Azure Bot registration |
| WhatsApp (Meta Cloud API) | Verification handshake, signature checks, replies, replies after approval | Delivery from Meta to your webhook and sending from your number |
| Stripe billing | Checkout/portal requests, webhook signatures, plan sync, plan limits | Real Checkout, webhook events from Stripe, the customer portal |

## Before you start: a public URL for webhooks

Slack, Teams, WhatsApp and Stripe call AgentFlow, so the API must be reachable from the internet. For local testing,
use a tunnel to port 4000:

```bash
npx cloudflared tunnel --url http://localhost:4000
```

Put the HTTPS address it prints into `.env` and restart `pnpm dev`:

```
PUBLIC_API_URL=https://<your-tunnel>.trycloudflare.com
```

Webhook URLs shown in the builder (Deploy → Messaging channels) use this address.

---

## AWS Bedrock

1. In the AWS console, open **Amazon Bedrock → Model access** and enable the models you want (for example Claude or Amazon Nova) in your region.
2. Create credentials, either:
   - a **Bedrock API key** (Bedrock console → API keys), or
   - an **IAM user/role** with `bedrock:InvokeModel` and use its access key.
3. In AgentFlow **Settings → Model provider keys**: provider **AWS Bedrock**,
   - API key: the Bedrock API key, **or** `ACCESS_KEY_ID:SECRET_ACCESS_KEY` (add `:SESSION_TOKEN` for temporary credentials);
   - Base URL or region: your region, e.g. `us-east-1`.
4. On an AI Agent node choose **AWS Bedrock** and enter the model ID exactly as Bedrock shows it
   (e.g. `anthropic.claude-3-5-sonnet-20240620-v1:0`, or an inference-profile ID such as `us.anthropic…`).
5. **Check:** ▶ Test in the editor. Replies arrive in one piece (Bedrock is called without streaming). Errors show the
   message from AWS (for example "You don't have access to the model").

## Google Vertex AI (Gemini)

1. In Google Cloud, enable the **Vertex AI API** for your project.
2. Create a **service account** with the role **Vertex AI User**, then create a **JSON key** for it.
3. In AgentFlow **Settings → Model provider keys**: provider **Google Vertex (Gemini)**,
   - API key: paste the whole JSON key file;
   - Base URL or region: the location, e.g. `us-central1` (or `global`).
4. On an AI Agent node choose **Google Vertex (Gemini)** and a model such as `gemini-2.5-flash`.
5. **Check:** ▶ Test. Replies stream. If the token exchange fails, the error comes from Google OAuth.

Note: Gemini accepts a subset of JSON Schema for tool parameters; very complex MCP tool schemas may need simplifying.

## Slack

1. Create an app at <https://api.slack.com/apps> → **From scratch**.
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `app_mentions:read`, `im:history` (and `channels:history` if it
   should read channel threads). Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information → Signing Secret**: copy it.
4. In AgentFlow: open the flow → **Deploy → Messaging channels → Connect Slack**, paste the token and signing secret, and
   copy the webhook URL shown.
5. In Slack **Event Subscriptions**: turn on, paste the webhook URL (Slack verifies it immediately), and subscribe to bot
   events `app_mention` and `message.im`. Reinstall the app if Slack asks.
6. **Check:** mention the bot in a channel or DM it. It replies in a thread; replies in the same thread continue the
   conversation. Approvals: the "please wait" message appears first, the decision's reply follows after the Inbox decision.

## Microsoft Teams

1. In Azure, create an **Azure Bot** resource (multi-tenant or single-tenant). Note the **Microsoft App ID** and create a
   **client secret** (the app password). For single-tenant bots, also note the **tenant ID**.
2. In AgentFlow: **Deploy → Messaging channels → Connect Microsoft Teams** with the App ID, app password and (if single-tenant)
   tenant ID. Copy the webhook URL.
3. In the Azure Bot → **Configuration**, set the **Messaging endpoint** to that URL. Under **Channels**, add **Microsoft Teams**.
4. Install the bot in Teams (from the Azure Bot "Open in Teams" link, or with a Teams app manifest).
5. **Check:** send the bot a message. AgentFlow checks the Bot Framework token (signed by Microsoft, for your App ID) and
   replies to the message.

## WhatsApp (Meta Cloud API)

1. In <https://developers.facebook.com>, create an app with the **WhatsApp** product. Note the **Phone number ID** and create
   an access token (a temporary token works for testing; use a System User token for production).
2. **App settings → Basic → App secret**: copy it.
3. In AgentFlow: **Deploy → Messaging channels → Connect WhatsApp** with the phone number ID, access token, app secret, and a
   **verify token** you make up. Copy the webhook URL.
4. In Meta **WhatsApp → Configuration → Webhook**: paste the URL and the same verify token (Meta checks it immediately), then
   subscribe to the **messages** field.
5. **Check:** from a test number added in Meta, send a WhatsApp message. AgentFlow verifies the `X-Hub-Signature-256` header
   and replies. Form nodes become a text prompt ("Please reply with: …").

## Stripe billing

1. In the Stripe dashboard (**test mode**), create two recurring **Prices**: Pro ($99/month) and Business ($499/month).
2. **Developers → API keys**: copy the secret key (`sk_test_…`).
3. **Developers → Webhooks → Add endpoint**: URL `${PUBLIC_API_URL}/v1/billing/webhook`, events
   `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret.
   (Or forward locally: `stripe listen --forward-to localhost:4000/v1/billing/webhook`.)
4. Add to `.env` and restart:

   ```
   STRIPE_SECRET_KEY=sk_test_…
   STRIPE_WEBHOOK_SECRET=whsec_…
   STRIPE_PRICE_PRO=price_…
   STRIPE_PRICE_BUSINESS=price_…
   ```
5. Turn on the **customer portal** in Stripe (Settings → Billing → Customer portal).
6. **Check:** **Billing → Upgrade** opens Stripe Checkout; pay with card `4242 4242 4242 4242`. After the webhook arrives, the
   plan shows Pro. **Manage billing** opens the portal; cancelling there moves the org back to Free.

With billing on, each organization's plan limits **live conversations per month** (Free 100, Pro 2,000, Business 15,000;
tests, evals and subflow runs don't count). Without `STRIPE_SECRET_KEY`, there are no limits.
