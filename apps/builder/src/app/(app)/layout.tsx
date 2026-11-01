import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Button, Select } from "@agentflow/ui";
import { auth } from "@/auth";
import { Logo } from "@/components/logo";
import { MobileMenu, Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { getContext } from "@/lib/context";
import { signOutAction, switchWorkspace } from "../actions";

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await auth())?.user) redirect("/login");
  const { user, workspaces, current } = await getContext();
  if (!current) redirect("/onboarding");

  return (
    <div className="flex min-h-screen">
      <Sidebar logo={<Logo />} footer="Phase 3 · Enterprise" />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4 md:px-6">
          <div className="flex items-center gap-2">
            <MobileMenu logo={<Logo />} />
            <form action={switchWorkspace} className="flex items-center gap-2">
              <label htmlFor="workspaceId" className="sr-only">
                Workspace
              </label>
              <Select id="workspaceId" name="workspaceId" defaultValue={current.id} className="h-8 w-56">
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.orgName} / {w.name}
                  </option>
                ))}
              </Select>
              {workspaces.length > 1 && (
                <Button type="submit" variant="secondary" size="sm">
                  Switch
                </Button>
              )}
            </form>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted sm:inline">{user.email}</span>
            <ThemeToggle />
            <form action={signOutAction}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-6">{children}</main>
      </div>
    </div>
  );
}
