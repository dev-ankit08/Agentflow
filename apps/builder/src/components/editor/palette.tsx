"use client";

import { useState, type DragEvent } from "react";
import type { NodeType } from "@agentflow/flow-schema";
import { InfoTip, Tooltip } from "@agentflow/ui";
import { nodeMeta, paletteGroups } from "./model";

/** The «/» button that collapses or expands a side panel. */
export function PanelToggle({
  side,
  collapsed,
  label,
  onClick,
}: {
  side: "left" | "right";
  collapsed: boolean;
  label: string;
  onClick: () => void;
}) {
  const arrow = (side === "left") === collapsed ? "»" : "«";
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-muted hover:bg-surface-2 hover:text-text"
      >
        {arrow}
      </button>
    </Tooltip>
  );
}

/** Node palette: searchable groups, or a rail of node icons when collapsed. Drag or click a node to add it. */
export function Palette({
  collapsed,
  onToggle,
  canEdit,
  dragType,
  onAdd,
}: {
  collapsed: boolean;
  onToggle: () => void;
  canEdit: boolean;
  dragType: string;
  onAdd: (type: NodeType) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const groups = paletteGroups
    .map((g) => ({
      ...g,
      types: g.types.filter(
        (t) => !q || nodeMeta[t].label.toLowerCase().includes(q) || nodeMeta[t].hint.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.types.length);
  const dragStart = (type: NodeType) => (e: DragEvent) => {
    e.dataTransfer.setData(dragType, type);
    e.dataTransfer.effectAllowed = "move";
  };
  const tip = (type: NodeType) => (
    <>
      <span className="font-semibold">{nodeMeta[type].label}</span> — {nodeMeta[type].hint}
      {canEdit && <span className="mt-1 block text-muted">Drag onto the canvas or click to add.</span>}
    </>
  );

  if (collapsed)
    return (
      <aside
        aria-label="Node palette"
        className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-surface py-2"
      >
        <PanelToggle side="left" collapsed label="Show nodes  [" onClick={onToggle} />
        <div className="my-1 h-px w-6 bg-border" />
        {paletteGroups
          .flatMap((g) => g.types)
          .map((type) => (
            <Tooltip key={type} content={tip(type)}>
              <button
                type="button"
                draggable={canEdit}
                disabled={!canEdit}
                aria-label={`Add ${nodeMeta[type].label}`}
                onDragStart={dragStart(type)}
                onClick={() => onAdd(type)}
                className="flex h-8 w-8 cursor-grab items-center justify-center rounded-md text-sm text-white transition hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: nodeMeta[type].color }}
              >
                {nodeMeta[type].icon}
              </button>
            </Tooltip>
          ))}
      </aside>
    );

  return (
    <aside aria-label="Node palette" className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <p className="text-xs font-semibold text-text">Nodes</p>
        <InfoTip label="How to add nodes">
          Drag nodes onto the canvas (or click one to add it), then connect the dots. Ctrl+C / Ctrl+V copies nodes;
          Delete removes them.
        </InfoTip>
        <span className="ml-auto">
          <PanelToggle side="left" collapsed={false} label="Hide nodes  [" onClick={onToggle} />
        </span>
      </div>
      <div className="px-3 pt-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes…"
          aria-label="Search nodes"
          className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {groups.map((g) => (
          <details key={g.title + (q ? "-search" : "")} open className="group mb-3">
            <summary className="mb-1.5 flex cursor-pointer list-none items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted hover:text-text [&::-webkit-details-marker]:hidden">
              <span className="inline-block transition group-open:rotate-90">▸</span>
              {g.title}
            </summary>
            {g.types.map((type) => (
              <Tooltip key={type} content={tip(type)} className="flex w-full">
                <button
                  type="button"
                  draggable={canEdit}
                  disabled={!canEdit}
                  onDragStart={dragStart(type)}
                  onClick={() => onAdd(type)}
                  className="mb-1 flex w-full cursor-grab items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-left text-xs text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white"
                    style={{ background: nodeMeta[type].color }}
                    aria-hidden
                  >
                    {nodeMeta[type].icon}
                  </span>
                  {nodeMeta[type].label}
                </button>
              </Tooltip>
            ))}
          </details>
        ))}
        {groups.length === 0 && <p className="text-xs text-muted">No nodes match “{query}”.</p>}
      </div>
    </aside>
  );
}
