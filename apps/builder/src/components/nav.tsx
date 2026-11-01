"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip, cn } from "@agentflow/ui";

export type NavItem = { href: string; label: string; icon: string; phase?: number };

export const navItems: NavItem[] = [
  { href: "/", label: "Home", icon: "⌂" },
  { href: "/flows", label: "Flows", icon: "⇶" },
  { href: "/templates", label: "Templates", icon: "❏" },
  { href: "/prompts", label: "Prompts", icon: "✎" },
  { href: "/connectors", label: "Connectors", icon: "⇌" },
  { href: "/knowledge", label: "Knowledge", icon: "❖" },
  { href: "/runs", label: "Runs & Traces", icon: "≡" },
  { href: "/evals", label: "Evals", icon: "✓" },
  { href: "/inbox", label: "Inbox", icon: "✉" },
  { href: "/analytics", label: "Analytics", icon: "▤" },
  { href: "/audit", label: "Audit log", icon: "⎘" },
  { href: "/billing", label: "Billing", icon: "$" },
  { href: "/settings", label: "Settings", icon: "⚙︎" },
];

/** Main navigation; `collapsed` shows icons only, with the names in tooltips. */
export function Nav({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {navItems.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const link = (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg py-2 text-sm transition",
              collapsed ? "w-full justify-center px-0" : "px-3",
              active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            <span className="w-4 text-center" aria-hidden>
              {item.icon}
            </span>
            {!collapsed && <span className="flex-1">{item.label}</span>}
            {!collapsed && item.phase && (
              <span className="text-[10px] uppercase tracking-wide text-muted">P{item.phase}</span>
            )}
          </Link>
        );
        return collapsed ? (
          <Tooltip key={item.href} content={item.label} className="flex w-full">
            {link}
          </Tooltip>
        ) : (
          link
        );
      })}
    </nav>
  );
}
