"use client";

import { useState } from "react";
import { Button, Input, Select } from "@agentflow/ui";

type LibraryPrompt = { id: string; name: string; description: string | null; body: string };

/** Use a saved prompt from the workspace library, or save the current one to it. */
export function PromptLibrary({
  value,
  onUse,
  disabled,
}: {
  value: string;
  onUse: (body: string) => void;
  disabled: boolean;
}) {
  const [prompts, setPrompts] = useState<LibraryPrompt[] | null>(null);
  const [mode, setMode] = useState<"closed" | "use" | "save">("closed");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function open(next: "use" | "save") {
    setStatus(null);
    setMode(next);
    if (next === "use" && prompts === null) {
      const res = await fetch("/api/v1/prompts").catch(() => null);
      setPrompts(res?.ok ? (await res.json()).prompts : []);
    }
  }

  async function save() {
    const res = await fetch("/api/v1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), body: value }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) return setStatus(body.issues?.[0]?.message ?? body.error ?? "Could not save");
    setPrompts((p) => (p ? [...p, body] : p));
    setName("");
    setMode("closed");
    setStatus(`Saved "${body.name}" to the library`);
  }

  if (disabled) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex gap-3 text-[11px]">
        <button type="button" className="text-accent hover:underline" onClick={() => void open("use")}>
          Use from library
        </button>
        <button
          type="button"
          className="text-accent hover:underline disabled:text-muted disabled:no-underline"
          disabled={!value.trim()}
          onClick={() => void open("save")}
        >
          Save to library
        </button>
        {status && <span className="text-muted">{status}</span>}
      </div>
      {mode === "use" && (
        <div className="rounded-lg border border-border p-2">
          {prompts === null ? (
            <p className="text-[11px] text-muted">Loading…</p>
          ) : prompts.length === 0 ? (
            <p className="text-[11px] text-muted">No saved prompts yet. Save one, or add them on the Prompts page.</p>
          ) : (
            <Select
              aria-label="Library prompt"
              className="h-8 text-xs"
              value=""
              onChange={(e) => {
                const chosen = prompts.find((p) => p.id === e.target.value);
                if (!chosen) return;
                if (
                  value.trim() &&
                  value !== chosen.body &&
                  !window.confirm(`Replace the current prompt with "${chosen.name}"?`)
                )
                  return;
                onUse(chosen.body);
                setMode("closed");
                setStatus(`Using "${chosen.name}"`);
              }}
            >
              <option value="">Choose a prompt…</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id} title={p.description ?? undefined}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
      {mode === "save" && (
        <form
          className="flex gap-1 rounded-lg border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          <Input
            value={name}
            autoFocus
            placeholder="Name, e.g. Friendly support tone"
            aria-label="Library prompt name"
            className="h-8 text-xs"
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setMode("closed")}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}
