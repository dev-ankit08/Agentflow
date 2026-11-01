import { redirect } from "next/navigation";
import { Alert, Button, Card, Field, Input } from "@agentflow/ui";
import { auth } from "@/auth";
import { Logo } from "@/components/logo";
import { createOrg, signOutAction } from "../actions";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md p-6">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold text-text">Create your organization</h1>
        <p className="mt-1 text-sm text-muted">
          Signed in as {session.user.email}. If a teammate invited you, ask them to resend the invite to this email.
        </p>
        {error && (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        )}
        <form action={createOrg} className="mt-6 space-y-4">
          <Field label="Organization name" htmlFor="orgName">
            <Input id="orgName" name="orgName" required maxLength={100} placeholder="Acme Inc." />
          </Field>
          <Field label="First workspace" htmlFor="workspaceName" hint="Workspaces separate teams or environments.">
            <Input id="workspaceName" name="workspaceName" maxLength={100} placeholder="Default" />
          </Field>
          <Button type="submit" className="w-full">
            Create organization
          </Button>
        </form>
        <form action={signOutAction} className="mt-3">
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            Sign out
          </Button>
        </form>
      </Card>
    </main>
  );
}
