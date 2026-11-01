import { Alert } from "@agentflow/ui";

/** Shows the `?error=` / `?ok=` message set by server actions. */
export function Flash({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return <div className="mb-4">{error ? <Alert>{error}</Alert> : <Alert tone="success">{ok}</Alert>}</div>;
}
