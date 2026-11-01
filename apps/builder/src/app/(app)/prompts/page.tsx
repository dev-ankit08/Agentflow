import { Button, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader } from "@agentflow/ui";
import { Flash } from "@/components/flash";
import { apiFetch } from "@/lib/api";
import { can, requireWorkspace } from "@/lib/context";
import { deletePrompt, savePrompt } from "../../actions-phase3";

type LibraryPrompt = { id: string; name: string; description: string | null; body: string; updatedAt: string };

const textarea =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text focus:border-accent focus:outline-none";

function PromptForm({ prompt, disabled }: { prompt?: LibraryPrompt; disabled: boolean }) {
  const key = prompt?.id ?? "new";
  return (
    <form action={savePrompt} className="grid gap-3">
      {prompt && <input type="hidden" name="id" value={prompt.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${key}-name`}>
          <Input
            id={`${key}-name`}
            name="name"
            required
            maxLength={120}
            defaultValue={prompt?.name}
            disabled={disabled}
          />
        </Field>
        <Field label="Description (optional)" htmlFor={`${key}-description`}>
          <Input
            id={`${key}-description`}
            name="description"
            maxLength={500}
            defaultValue={prompt?.description ?? ""}
            disabled={disabled}
          />
        </Field>
      </div>
      <Field
        label="Prompt"
        htmlFor={`${key}-body`}
        hint="Use {{variables}} and {{#if}} blocks as in any agent prompt. Agents copy the prompt when they use it."
      >
        <textarea
          id={`${key}-body`}
          name="body"
          required
          rows={prompt ? 6 : 5}
          defaultValue={prompt?.body}
          disabled={disabled}
          className={textarea}
        />
      </Field>
      {!disabled && (
        <div>
          <Button type="submit" size="sm">
            {prompt ? "Save changes" : "Add prompt"}
          </Button>
        </div>
      )}
    </form>
  );
}

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { current } = await requireWorkspace();
  const canEdit = can(current, "builder");
  const { prompts } = await apiFetch<{ prompts: LibraryPrompt[] }>("/v1/prompts", { workspaceId: current.id });
  const { error, ok } = await searchParams;

  return (
    <>
      <PageHeader
        title="Prompt library"
        description="Reusable prompts for your agents: tone of voice, policies, output rules. Pick one from any agent's system prompt."
      />
      <Flash error={error} ok={ok} />
      <div className="space-y-6">
        {canEdit && (
          <Card>
            <CardHeader title="New prompt" />
            <CardBody>
              <PromptForm disabled={false} />
            </CardBody>
          </Card>
        )}
        {prompts.length === 0 ? (
          <EmptyState
            title="No saved prompts yet"
            description="Add one here, or use “Save to library” under an agent's system prompt in the editor."
          />
        ) : (
          prompts.map((p) => (
            <Card key={p.id}>
              <CardHeader
                title={p.name}
                subtitle={`${p.description ? `${p.description} · ` : ""}updated ${new Date(p.updatedAt).toLocaleDateString()}`}
              />
              <CardBody className="space-y-3">
                <details>
                  <summary className="cursor-pointer text-sm text-accent">{canEdit ? "View and edit" : "View"}</summary>
                  <div className="mt-3">
                    <PromptForm prompt={p} disabled={!canEdit} />
                  </div>
                </details>
                {canEdit && (
                  <form action={deletePrompt}>
                    <input type="hidden" name="id" value={p.id} />
                    <Button type="submit" variant="ghost" size="sm">
                      Delete
                    </Button>
                  </form>
                )}
              </CardBody>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
