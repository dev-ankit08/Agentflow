import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@agentflow/ui";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";

type Step = { done: boolean; title: string; description: string; href?: string; phase?: number };

export default async function HomePage() {
  const { current } = await requireWorkspace();
  const [{ flows }, { providers }, { connectors }, { runs }] = await Promise.all([
    apiFetch<{ flows: { liveVersionId: string | null }[] }>("/v1/flows", { workspaceId: current.id }),
    apiFetch<{ providers: string[] }>("/v1/providers", { workspaceId: current.id }),
    apiFetch<{ connectors: unknown[] }>("/v1/connectors", { workspaceId: current.id }),
    apiFetch<{ runs: unknown[] }>("/v1/runs?limit=1", { workspaceId: current.id }),
  ]);

  const steps: Step[] = [
    {
      done: providers.length > 0,
      title: "Connect a model",
      description: "Add a Claude, OpenAI, Azure OpenAI or OpenAI-compatible key.",
      href: can(current, "admin") ? "/settings#provider-keys" : undefined,
    },
    {
      done: connectors.length > 0,
      title: "Connect your data (optional)",
      description: "Add an MCP server so agents can look things up and take action.",
      href: "/connectors",
    },
    {
      done: flows.length > 0,
      title: "Create a flow from a template",
      description: "Start from a proven outcome flow, or a blank canvas.",
      href: "/templates",
    },
    {
      done: runs.length > 0,
      title: "Test it",
      description: "Open the flow and click ▶ Test to chat with your draft.",
      href: "/flows",
    },
    {
      done: flows.some((f) => f.liveVersionId),
      title: "Publish and embed",
      description: "Publish, then paste one script tag on your website (Deploy page).",
      href: "/flows",
    },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome to ${current.orgName}`}
        subtitle={`Workspace: ${current.name} · Role: ${current.role}`}
      />
      <Card>
        <CardHeader title="Get started" description="Go from zero to an AI agent on your website." />
        <CardBody className="p-0">
          <ol className="divide-y divide-border">
            {steps.map((step, i) => (
              <li key={step.title} className="flex items-center gap-4 px-5 py-4">
                <span
                  className={
                    step.done
                      ? "flex h-7 w-7 items-center justify-center rounded-full bg-success text-sm text-white"
                      : "flex h-7 w-7 items-center justify-center rounded-full border border-border text-sm text-muted"
                  }
                  aria-label={step.done ? "Done" : `Step ${i + 1}`}
                >
                  {step.done ? "✓" : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text">
                    {step.href && !step.phase ? (
                      <Link href={step.href} className="hover:text-accent">
                        {step.title}
                      </Link>
                    ) : (
                      step.title
                    )}
                  </p>
                  <p className="text-sm text-muted">{step.description}</p>
                </div>
                {step.phase && <Badge>Phase {step.phase}</Badge>}
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </>
  );
}
