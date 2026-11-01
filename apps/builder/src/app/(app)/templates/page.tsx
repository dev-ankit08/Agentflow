import Link from "next/link";
import { Badge, Button, Card, Field, Input, PageHeader, Select } from "@agentflow/ui";
import { modelSuggestions, providerLabels } from "@/components/editor/model";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { installTemplate } from "../../actions";

type Template = {
  slug: string;
  name: string;
  category: string;
  description: string;
  outcome: string;
  minutes: number;
  connector?: { label: string; tools: string[]; hint: string };
};
type Connector = { id: string; name: string; toolCatalog: { name: string }[] };

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { current } = await requireWorkspace();
  const [{ templates }, { connectors }, { providers }] = await Promise.all([
    apiFetch<{ templates: Template[] }>("/v1/templates", { workspaceId: current.id }),
    apiFetch<{ connectors: Connector[] }>("/v1/connectors", { workspaceId: current.id }),
    apiFetch<{ providers: string[] }>("/v1/providers", { workspaceId: current.id }),
  ]);
  const canInstall = can(current, "builder");
  const defaultProvider = (providers[0] ?? "anthropic") as keyof typeof modelSuggestions;

  return (
    <>
      <PageHeader
        title="Templates"
        description="Start from a proven flow for a business outcome, then adjust it on the canvas."
      />
      <Flash error={(await searchParams).error} />
      {providers.length === 0 && (
        <p className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-text">
          No model key yet. Add one in{" "}
          <Link href="/settings#provider-keys" className="text-accent underline">
            Settings
          </Link>{" "}
          — or for a free local demo, run <code className="font-mono">corepack pnpm demo:llm</code> and add an
          OpenAI-compatible key with base URL <code className="font-mono">http://localhost:4010/v1</code>.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => {
          const eligible = t.connector
            ? connectors.filter((c) => t.connector!.tools.every((tool) => c.toolCatalog.some((x) => x.name === tool)))
            : [];
          return (
            <Card key={t.slug} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold text-text">{t.name}</h2>
                <Badge tone="accent">{t.category}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted">{t.description}</p>
              <p className="mt-2 text-xs text-muted">
                ⏱ ~{t.minutes} min · 📈 {t.outcome}
                {t.connector && ` · needs: ${t.connector.label}`}
              </p>
              {canInstall && (
                <details className="mt-4 rounded-lg border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium text-accent">Use this template</summary>
                  <form action={installTemplate} className="mt-3 space-y-3">
                    <input type="hidden" name="slug" value={t.slug} />
                    <Field label="Flow name" htmlFor={`${t.slug}-name`}>
                      <Input id={`${t.slug}-name`} name="name" defaultValue={t.name} maxLength={120} />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Provider" htmlFor={`${t.slug}-provider`}>
                        <Select id={`${t.slug}-provider`} name="provider" defaultValue={defaultProvider}>
                          {Object.entries(providerLabels)

                            .map(([p, label]) => (
                              <option key={p} value={p}>
                                {label}
                                {providers.includes(p) ? " ✓" : ""}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <Field label="Model" htmlFor={`${t.slug}-model`}>
                        <Input
                          id={`${t.slug}-model`}
                          name="model"
                          required
                          defaultValue={modelSuggestions[defaultProvider][0] ?? ""}
                        />
                      </Field>
                    </div>
                    {t.connector && (
                      <Field label={t.connector.label} htmlFor={`${t.slug}-connector`} hint={t.connector.hint}>
                        <Select
                          id={`${t.slug}-connector`}
                          name="connectorId"
                          required
                          defaultValue={eligible[0]?.id ?? ""}
                        >
                          <option value="" disabled>
                            {eligible.length ? "Choose a connector…" : "No matching connector yet"}
                          </option>
                          {eligible.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    <Button type="submit" className="w-full" disabled={Boolean(t.connector) && eligible.length === 0}>
                      Create flow
                    </Button>
                  </form>
                </details>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
