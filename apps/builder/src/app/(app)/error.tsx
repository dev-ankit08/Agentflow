"use client";

import { Alert, Button } from "@agentflow/ui";

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <Alert>
        <p className="font-medium">Something went wrong loading this page.</p>
        <p className="mt-1">
          {error.message.includes("fetch failed")
            ? "The AgentFlow API is not reachable. Is it running (pnpm dev) on API_URL?"
            : error.message}
        </p>
      </Alert>
      <Button className="mt-4" variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
