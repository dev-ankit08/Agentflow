"use client";

import { useState } from "react";
import { Alert, Button } from "@agentflow/ui";

export function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-surface-2 p-4 pr-20 font-mono text-xs text-text">{code}</pre>
      <Button
        size="sm"
        variant="secondary"
        className="absolute right-2 top-2"
        onClick={async () => {
          await navigator.clipboard.writeText(code).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** Generates the identity-token signing secret and shows it exactly once. */
export function IdentitySecret({ flowId, exists, canManage }: { flowId: string; exists: boolean; canManage: boolean }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        To let agents know who is signed in on your site, sign a short-lived JWT (HS256) on your server with this
        secret, then call <code className="font-mono">AgentFlow.identify(token)</code>. Its claims (sub, email, plan, …)
        become <code className="font-mono">{"{{user.*}}"}</code>.
      </p>
      {secret && (
        <Alert tone="success">
          Copy this secret now — it will not be shown again:
          <code className="mt-2 block break-all font-mono text-xs">{secret}</code>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {canManage && (
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            if (exists && !confirm("Rotate the secret? Tokens signed with the old secret will stop working.")) return;
            const res = await fetch(`/api/v1/flows/${flowId}/widget/identity-secret`, { method: "POST" });
            const body = await res.json().catch(() => ({}));
            if (res.ok) setSecret(body.secret);
            else setError(body.error ?? "Could not create a secret");
          }}
        >
          {exists ? "Rotate secret" : "Generate secret"}
        </Button>
      )}
    </div>
  );
}
