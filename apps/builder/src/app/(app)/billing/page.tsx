import { Alert, Badge, Button, Card, CardBody, CardHeader, PageHeader, cn } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { openBillingPortal, startCheckout } from "../../actions-integrations";

type Billing = {
  configured: boolean;
  plan: string;
  status: string | null;
  hasCustomer: boolean;
  usage: { conversations: number; limit: number | null };
  plans: { id: string; name: string; priceUsd: number | null; conversations: number | null; purchasable: boolean }[];
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { current } = await requireWorkspace();
  const b = await apiFetch<Billing>("/v1/billing", { workspaceId: current.id });
  const { error, ok } = await searchParams;
  const isOwner = can(current, "owner");
  const pct = b.usage.limit ? Math.min(100, Math.round((b.usage.conversations / b.usage.limit) * 100)) : 0;

  return (
    <>
      <PageHeader title="Billing" description={`${current.orgName} · plans are per organization`} />
      <Flash error={error} ok={ok} />
      {!b.configured && (
        <div className="mb-6">
          <Alert tone="accent">
            Billing is not configured, so there are no plan limits. To turn it on, set STRIPE_SECRET_KEY,
            STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO and STRIPE_PRICE_BUSINESS (see docs/08-integrations-setup.md).
          </Alert>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader
          title={
            <>
              Current plan: {b.plans.find((p) => p.id === b.plan)?.name ?? b.plan}
              {b.status && <Badge className="ml-2">{b.status}</Badge>}
            </>
          }
          action={
            isOwner &&
            b.hasCustomer && (
              <form action={openBillingPortal}>
                <Button type="submit" variant="secondary" size="sm">
                  Manage billing
                </Button>
              </form>
            )
          }
        />
        <CardBody>
          <p className="text-sm text-text">
            {b.usage.conversations.toLocaleString()} live conversation{b.usage.conversations === 1 ? "" : "s"} this
            month
            {b.usage.limit !== null && ` of ${b.usage.limit.toLocaleString()}`}
          </p>
          {b.usage.limit !== null && (
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn("h-full rounded-full", pct >= 90 ? "bg-danger" : "bg-accent")}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {b.plans.map((p) => (
          <Card key={p.id} className={cn("flex flex-col p-5", p.id === b.plan && "ring-2 ring-accent")}>
            <p className="font-semibold text-text">{p.name}</p>
            <p className="mt-1 text-2xl font-semibold text-text">
              {p.priceUsd === null ? "Custom" : p.priceUsd === 0 ? "$0" : `$${p.priceUsd}/mo`}
            </p>
            <p className="mt-1 text-sm text-muted">
              {p.conversations === null
                ? "Unlimited conversations"
                : `${p.conversations.toLocaleString()} conversations / month`}
            </p>
            <div className="mt-auto pt-4">
              {p.id === b.plan ? (
                <Badge tone="accent">Current plan</Badge>
              ) : p.purchasable && isOwner ? (
                <form action={startCheckout}>
                  <input type="hidden" name="plan" value={p.id} />
                  <Button type="submit" size="sm">
                    Upgrade
                  </Button>
                </form>
              ) : p.id === "enterprise" ? (
                <p className="text-xs text-muted">Contact sales</p>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
      {!isOwner && <p className="mt-4 text-xs text-muted">Only owners can change the plan.</p>}
    </>
  );
}
