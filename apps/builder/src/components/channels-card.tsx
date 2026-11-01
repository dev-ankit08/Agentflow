import { Badge, Button, Card, CardBody, CardHeader, Field, Input } from "@agentflow/ui";
import { addChannel, deleteChannel } from "@/app/actions-integrations";
import { CopyBlock } from "@/components/deploy-tools";

export type ChannelSummary = {
  id: string;
  type: "slack" | "teams" | "whatsapp";
  name: string;
  webhookUrl: string;
  createdAt: string;
};

const typeLabel = { slack: "Slack", teams: "Microsoft Teams", whatsapp: "WhatsApp" };

/** Connect this flow to Slack, Microsoft Teams or WhatsApp. Each connection gets a webhook URL to paste into the platform. */
export function ChannelsCard({
  flowId,
  channels,
  canManage,
  live,
}: {
  flowId: string;
  channels: ChannelSummary[];
  canManage: boolean;
  live: boolean;
}) {
  return (
    <Card>
      <CardHeader
        title="Messaging channels"
        description="Answer customers in Slack, Microsoft Teams or WhatsApp with this flow's live version."
      />
      {channels.length > 0 && (
        <ul className="divide-y divide-border">
          {channels.map((c) => (
            <li key={c.id} className="space-y-2 px-5 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-text">
                  {c.name} <Badge className="ml-1">{typeLabel[c.type]}</Badge>
                </p>
                {canManage && (
                  <form action={deleteChannel}>
                    <input type="hidden" name="flowId" value={flowId} />
                    <input type="hidden" name="id" value={c.id} />
                    <Button type="submit" variant="danger" size="sm">
                      Disconnect
                    </Button>
                  </form>
                )}
              </div>
              <CopyBlock code={c.webhookUrl} />
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <CardBody className="space-y-2 border-t border-border">
          {!live && <p className="text-xs text-warning">Publish the flow first — channels use the live version.</p>}
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium text-text">Connect Slack</summary>
            <form action={addChannel} className="mt-3 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="flowId" value={flowId} />
              <input type="hidden" name="type" value="slack" />
              <Field label="Bot token (xoxb-…)" htmlFor="s-bot">
                <Input id="s-bot" name="botToken" type="password" required autoComplete="off" />
              </Field>
              <Field label="Signing secret" htmlFor="s-sign">
                <Input id="s-sign" name="signingSecret" type="password" required autoComplete="off" />
              </Field>
              <Button type="submit" size="sm">
                Connect Slack
              </Button>
            </form>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium text-text">Connect Microsoft Teams</summary>
            <form action={addChannel} className="mt-3 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="flowId" value={flowId} />
              <input type="hidden" name="type" value="teams" />
              <Field label="Microsoft App ID" htmlFor="t-app">
                <Input id="t-app" name="appId" required />
              </Field>
              <Field label="App password (client secret)" htmlFor="t-pw">
                <Input id="t-pw" name="appPassword" type="password" required autoComplete="off" />
              </Field>
              <Field label="Tenant ID (single-tenant bots only)" htmlFor="t-tenant">
                <Input id="t-tenant" name="tenantId" />
              </Field>
              <div className="flex items-end">
                <Button type="submit" size="sm">
                  Connect Teams
                </Button>
              </div>
            </form>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium text-text">Connect WhatsApp</summary>
            <form action={addChannel} className="mt-3 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="flowId" value={flowId} />
              <input type="hidden" name="type" value="whatsapp" />
              <Field label="Phone number ID" htmlFor="w-phone">
                <Input id="w-phone" name="phoneNumberId" required />
              </Field>
              <Field label="Access token" htmlFor="w-token">
                <Input id="w-token" name="accessToken" type="password" required autoComplete="off" />
              </Field>
              <Field label="App secret" htmlFor="w-secret">
                <Input id="w-secret" name="appSecret" type="password" required autoComplete="off" />
              </Field>
              <Field label="Verify token (you choose, 8+ characters)" htmlFor="w-verify">
                <Input id="w-verify" name="verifyToken" required minLength={8} autoComplete="off" />
              </Field>
              <Button type="submit" size="sm">
                Connect WhatsApp
              </Button>
            </form>
          </details>
          <p className="text-[11px] text-muted">
            Secrets are encrypted at rest. Setup steps for each platform: docs/08-integrations-setup.md.
          </p>
        </CardBody>
      )}
    </Card>
  );
}
