"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@agentflow/ui";

export type NavItem = { href: string; label: string; phase?: number };

export const navItems: NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/flows", label: "Flows" },
  { href: "/templates", label: "Templates" },
  { href: "/prompts", label: "Prompts" },
  { href: "/connectors", label: "Connectors" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/runs", label: "Runs & Traces" },
  { href: "/evals", label: "Evals" },
  { href: "/inbox", label: "Inbox" },
  { href: "/analytics", label: "Analytics" },
  { href: "/audit", label: "Audit log" },
  { href: "/billing", label: "Billing" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {navItems.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center justify-between rounded-lg px-3 py-2 text-sm transition",
              active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {item.label}
            {item.phase && <span className="text-[10px] uppercase tracking-wide text-muted">P{item.phase}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
