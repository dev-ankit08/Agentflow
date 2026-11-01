"use client";

import { useState } from "react";
import { Button, Input } from "@agentflow/ui";

type Result = { text: string; title: string; uri: string | null; score: number };

export function KnowledgeSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    const res = await fetch("/api/v1/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }).catch(() => null);
    setResults(res?.ok ? (await res.json()).results : []);
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <form onSubmit={search} className="flex gap-2">
        <label htmlFor="kq" className="sr-only">
          Question
        </label>
        <Input
          id="kq"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="How long do refunds take?"
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          Search
        </Button>
      </form>
      {results && results.length === 0 && <p className="text-sm text-muted">No matching passages.</p>}
      {results?.map((r, i) => (
        <div key={i} className="rounded-lg border border-border p-3">
          <p className="mb-1 text-xs font-medium text-text">
            [{i + 1}] {r.title} <span className="text-muted">· score {r.score.toFixed(2)}</span>
          </p>
          <p className="line-clamp-4 text-xs text-muted">{r.text}</p>
        </div>
      ))}
    </div>
  );
}
