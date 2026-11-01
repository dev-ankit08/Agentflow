import { redirect } from "next/navigation";
import { Alert, Button, Card, Field, Input } from "@agentflow/ui";
import { auth, devLoginEnabled, emailLinksEnabled, googleEnabled, trialLoginEnabled, DEV_LOGIN_EMAIL } from "@/auth";
import { Logo } from "@/components/logo";
import { signInDev, signInTrial, signInWithEmail, signInWithGoogle } from "../actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ check?: string; error?: string }>;
}) {
  if ((await auth())?.user) redirect("/");
  const { check, error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6">
          <Logo />
          <h1 className="mt-6 text-xl font-semibold text-text">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Build, test and deploy AI agent workflows.</p>
        </div>

        {check && (
          <div className="mb-4">
            <Alert tone="success">
              Check your email for a sign-in link. Without SMTP configured, the link is printed in the builder terminal.
            </Alert>
          </div>
        )}
        {error && (
          <div className="mb-4">
            <Alert>
              {error === "trial"
                ? "That access code is not right. Check it with whoever invited you."
                : `Sign-in failed (${error}). Please try again.`}
            </Alert>
          </div>
        )}

        {trialLoginEnabled && (
          <form action={signInTrial} className="space-y-3">
            <Field label="Work email" htmlFor="trial-email">
              <Input
                id="trial-email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Trial access code" htmlFor="code" hint="The code from whoever invited you to try AgentFlow.">
              <Input id="code" name="code" type="password" required autoComplete="off" />
            </Field>
            <Button type="submit" className="w-full">
              Start trial
            </Button>
          </form>
        )}

        {emailLinksEnabled && (
          <form
            action={signInWithEmail}
            className={trialLoginEnabled ? "mt-4 space-y-3 border-t border-border pt-4" : "space-y-3"}
          >
            <Field label="Work email" htmlFor="email">
              <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
            </Field>
            <Button type="submit" variant={trialLoginEnabled ? "secondary" : "primary"} className="w-full">
              Email me a sign-in link
            </Button>
          </form>
        )}

        {(googleEnabled || devLoginEnabled) && (
          <div className="mt-4 space-y-2 border-t border-border pt-4">
            {googleEnabled && (
              <form action={signInWithGoogle}>
                <Button type="submit" variant="secondary" className="w-full">
                  Continue with Google
                </Button>
              </form>
            )}
            {devLoginEnabled && (
              <form action={signInDev}>
                <Button type="submit" variant="ghost" className="w-full">
                  Dev login ({DEV_LOGIN_EMAIL})
                </Button>
              </form>
            )}
          </div>
        )}
      </Card>
    </main>
  );
}
