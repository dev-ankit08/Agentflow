import { createHmac } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { orgs, runs, workspaces, type Db } from "@agentflow/db";
import { HttpError } from "./auth";
import { safeEqual } from "./channels";

export type PlanId = "free" | "pro" | "business" | "enterprise";
export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  prices: Partial<Record<"pro" | "business", string>>;
  /** Builder URL, for Checkout success/cancel and portal return links. */
  appUrl: string;
  apiBase?: string;
};

/** docs/06-go-to-market-and-pricing.md §3 (live conversations per month). */
export const PLANS: Record<PlanId, { name: string; priceUsd: number | null; conversations: number | null }> = {
  free: { name: "Free", priceUsd: 0, conversations: 100 },
  pro: { name: "Pro", priceUsd: 99, conversations: 2_000 },
  business: { name: "Business", priceUsd: 499, conversations: 15_000 },
  enterprise: { name: "Enterprise", priceUsd: null, conversations: null },
};

type BillingInfo = { customerId?: string; subscriptionId?: string; status?: string; priceId?: string };

/** Stripe's Stripe-Signature header: t=timestamp,v1=HMAC-SHA256(secret, "{t}.{raw body}"), max 5 minutes old. */
export function verifyStripeSignature(secret: string, header: string | undefined, raw: string, now = Date.now()) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .some((p) => safeEqual(p.slice(3), expected));
}

/** Flattens nested params into Stripe's form encoding (a[b][0]=c). */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (typeof v === "object") return formEncode(v as Record<string, unknown>, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
  });
}

export function makeBilling(db: Db, cfg: StripeConfig | null) {
  const api = cfg?.apiBase ?? "https://api.stripe.com/v1";

  async function stripe<T>(path: string, params: Record<string, unknown>): Promise<T> {
    if (!cfg) throw new HttpError(501, "Billing is not configured (set STRIPE_SECRET_KEY)");
    const res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: formEncode(params).join("&"),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new HttpError(502, `Stripe: ${body.error?.message ?? res.statusText}`);
    return body;
  }

  const orgRow = async (orgId: string) => {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) throw new HttpError(404, "Organization not found");
    return org;
  };
  const billingOf = (settings: Record<string, unknown>) => (settings.billing as BillingInfo | undefined) ?? {};
  const planForPrice = (priceId: string | undefined): PlanId =>
    priceId && priceId === cfg?.prices.business ? "business" : priceId && priceId === cfg?.prices.pro ? "pro" : "free";

  async function saveBilling(orgId: string, plan: PlanId | null, info: BillingInfo) {
    const org = await orgRow(orgId);
    await db
      .update(orgs)
      .set({ ...(plan && { plan }), settings: { ...org.settings, billing: { ...billingOf(org.settings), ...info } } })
      .where(eq(orgs.id, orgId));
  }

  /** Live conversations this month across the org's workspaces (tests, evals and subflow runs excluded). */
  async function monthConversations(orgId: string) {
    const d = new Date();
    const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const wsIds = (await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, orgId))).map(
      (w) => w.id,
    );
    if (wsIds.length === 0) return 0;
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          inArray(runs.workspaceId, wsIds),
          gte(runs.startedAt, since),
          isNotNull(runs.flowVersionId),
          eq(runs.sandbox, false),
          eq(runs.triggerType, "chat"),
        ),
      );
    return row?.n ?? 0;
  }

  return {
    configured: Boolean(cfg),

    async summary(orgId: string) {
      const org = await orgRow(orgId);
      const plan = (org.plan in PLANS ? org.plan : "free") as PlanId;
      const used = await monthConversations(orgId);
      const info = billingOf(org.settings);
      return {
        configured: Boolean(cfg),
        plan,
        status: info.status ?? null,
        hasCustomer: Boolean(info.customerId),
        usage: { conversations: used, limit: cfg ? PLANS[plan].conversations : null },
        plans: Object.entries(PLANS).map(([id, p]) => ({
          id,
          ...p,
          purchasable: Boolean(cfg?.prices[id as "pro" | "business"]),
        })),
      };
    },

    /** Starts a Stripe Checkout subscription for the org and returns its URL. */
    async checkout(orgId: string, plan: "pro" | "business", email: string | null) {
      const price = cfg?.prices[plan];
      if (!cfg || !price) throw new HttpError(400, `The ${plan} plan has no Stripe price configured`);
      const org = await orgRow(orgId);
      let customerId = billingOf(org.settings).customerId;
      if (!customerId) {
        const customer = await stripe<{ id: string }>("/customers", {
          email: email ?? undefined,
          name: org.name,
          metadata: { org_id: orgId },
        });
        customerId = customer.id;
        await saveBilling(orgId, null, { customerId });
      }
      const session = await stripe<{ url: string }>("/checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        client_reference_id: orgId,
        line_items: { 0: { price, quantity: 1 } },
        success_url: `${cfg.appUrl}/billing?ok=${encodeURIComponent("Subscription started — thank you!")}`,
        cancel_url: `${cfg.appUrl}/billing`,
        metadata: { org_id: orgId, plan },
        subscription_data: { metadata: { org_id: orgId } },
      });
      return session.url;
    },

    /** Stripe's hosted portal for invoices, payment methods and cancellation. */
    async portal(orgId: string) {
      const org = await orgRow(orgId);
      const customerId = billingOf(org.settings).customerId;
      if (!cfg || !customerId) throw new HttpError(400, "No Stripe customer yet — choose a plan first");
      const session = await stripe<{ url: string }>("/billing_portal/sessions", {
        customer: customerId,
        return_url: `${cfg.appUrl}/billing`,
      });
      return session.url;
    },

    /** Applies subscription changes from Stripe webhooks to the org's plan. */
    async handleWebhook(raw: string, signature: string | undefined) {
      if (!cfg) throw new HttpError(501, "Billing is not configured");
      if (!verifyStripeSignature(cfg.webhookSecret, signature, raw))
        throw new HttpError(400, "Invalid Stripe signature");
      const event = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };
      const obj = event.data.object;
      if (event.type === "checkout.session.completed") {
        const orgId =
          (obj.metadata as Record<string, string> | undefined)?.org_id ??
          (obj.client_reference_id as string | undefined);
        const plan = (obj.metadata as Record<string, string> | undefined)?.plan as PlanId | undefined;
        if (orgId)
          await saveBilling(orgId, plan ?? null, {
            customerId: obj.customer as string,
            subscriptionId: obj.subscription as string,
            status: "active",
          });
      } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        const orgId = (obj.metadata as Record<string, string> | undefined)?.org_id;
        const status = obj.status as string;
        const priceId =
          (obj.items as { data?: { price?: { id?: string } }[] } | undefined)?.data?.[0]?.price?.id ?? undefined;
        const active =
          event.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].includes(status);
        if (orgId)
          await saveBilling(orgId, active ? planForPrice(priceId) : "free", {
            subscriptionId: obj.id as string,
            status,
            priceId,
          });
      }
      return { received: true, type: event.type };
    },

    /** Blocks new live conversations when the org has used its plan's monthly allowance (only when billing is on). */
    async checkConversationLimit(workspaceId: string) {
      if (!cfg) return;
      const [ws] = await db.select({ orgId: workspaces.orgId }).from(workspaces).where(eq(workspaces.id, workspaceId));
      if (!ws) return;
      const org = await orgRow(ws.orgId);
      const limit = PLANS[(org.plan in PLANS ? org.plan : "free") as PlanId].conversations;
      if (limit !== null && (await monthConversations(ws.orgId)) >= limit) {
        throw new HttpError(402, "This assistant has reached its monthly conversation limit. Please try again later.");
      }
    },
  };
}

export type Billing = ReturnType<typeof makeBilling>;
