"use client";

import { Button } from "@agentflow/ui";

export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const isDark =
      root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("af-theme", next);
    } catch {
      // Storage unavailable (private mode); the choice lasts for this page only.
    }
  };
  return (
    <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle light or dark theme">
      ◐
    </Button>
  );
}
