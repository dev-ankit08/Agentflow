"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const GAP = 6;
const EDGE = 8;

/**
 * Shows `content` on hover or keyboard focus. Rendered in a portal with fixed positioning so scrolling panels and
 * transformed canvases don't clip it; flips above when there's no room below and stays inside the viewport.
 */
export function Tooltip({
  content,
  children,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  /** Classes for the wrapper, e.g. "flex w-full" around a full-width button. */
  className?: string;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const left = Math.min(Math.max(a.left + a.width / 2 - t.width / 2, EDGE), window.innerWidth - t.width - EDGE);
    const below = a.bottom + GAP;
    const top = below + t.height > window.innerHeight - EDGE ? a.top - GAP - t.height : below;
    setPos({ left, top: Math.max(top, EDGE) });
  }, [open]);

  const hide = () => {
    setOpen(false);
    setPos(null);
  };

  return (
    <span
      ref={anchor}
      className={className ?? "inline-flex"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={hide}
      onFocus={() => setOpen(true)}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === "Escape") hide();
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={tip}
            id={id}
            role="tooltip"
            style={{
              position: "fixed",
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
            className="pointer-events-none z-[1000] block w-max max-w-xs whitespace-normal rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-xs font-normal normal-case leading-snug tracking-normal text-text shadow-lg"
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** A small "i" button that explains the thing next to it in a tooltip. */
export function InfoTip({ children, label = "More info" }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border font-serif text-[10px] font-semibold italic leading-none text-muted transition hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        i
      </button>
    </Tooltip>
  );
}
