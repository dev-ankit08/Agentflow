"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Tooltip, cn } from "@agentflow/ui";
import { useStoredState } from "@/lib/use-stored-state";
import { Nav } from "./nav";

/** The app's left navigation: full width or a rail of icons (remembered per browser). */
export function Sidebar({ logo, footer }: { logo: ReactNode; footer?: ReactNode }) {
  const [prefs, setPrefs] = useStoredState("af-sidebar", { collapsed: false });
  const collapsed = prefs.collapsed;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-surface py-4 transition-[width] md:flex",
        collapsed ? "w-16 px-2" : "w-60 px-3",
      )}
    >
      <div className={cn("flex items-center pb-5", collapsed ? "justify-center" : "justify-between px-3")}>
        {!collapsed && logo}
        <Tooltip content={label}>
          <button
            type="button"
            aria-label={label}
            aria-expanded={!collapsed}
            onClick={() => setPrefs({ collapsed: !collapsed })}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          >
            {collapsed ? "»" : "«"}
          </button>
        </Tooltip>
      </div>
      <Nav collapsed={collapsed} />
      {!collapsed && footer && <div className="mt-auto px-3 text-xs text-muted">{footer}</div>}
    </aside>
  );
}

/** Menu button and slide-in navigation for small screens, where the sidebar is hidden. */
export function MobileMenu({ logo }: { logo: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [prevPath, setPrevPath] = useState(pathname);
  // Close after navigating (adjusting state during render instead of in an effect).
  if (pathname !== prevPath) {
    setPrevPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-lg text-text hover:bg-surface-2 md:hidden"
      >
        ☰
      </button>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface px-3 py-4 shadow-xl">
            <div className="flex items-center justify-between px-3 pb-5">
              {logo}
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-2"
              >
                ×
              </button>
            </div>
            <Nav />
          </div>
        </div>
      )}
    </>
  );
}
