"use client";

import { Fragment, useMemo } from "react";
import type { MemoryGraph, MemoryNode } from "@/lib/types";
import {
  CONNECTIVITY_COLOR,
  CONNECTIVITY_LABEL,
  nodeColor,
  TYPE_LABEL,
} from "@/lib/visual";
import { cn } from "@/lib/cn";

interface Props {
  graph: MemoryGraph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface NeighborRow {
  node: MemoryNode;
  kind: string;
  strong: boolean;
}

export default function NodeDetail({ graph, selectedId, onSelect }: Props) {
  const node = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );

  const neighbors = useMemo<NeighborRow[]>(() => {
    if (!selectedId) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const rows: NeighborRow[] = [];
    for (const e of graph.edges) {
      let otherId: string | null = null;
      if (e.source === selectedId) otherId = e.target;
      else if (e.target === selectedId) otherId = e.source;
      if (!otherId) continue;
      const other = byId.get(otherId);
      if (!other) continue;
      rows.push({ node: other, kind: e.label ?? e.kind, strong: e.strong });
    }
    return rows.sort((a, b) => Number(b.strong) - Number(a.strong));
  }, [graph, selectedId]);

  if (!node) {
    return (
      <div className="text-[var(--muted)] text-[13px] py-8 px-2 text-center leading-relaxed font-medium">
        Click any node to inspect it.
        <br />
        Green = linked, amber = cluster-only, red = isolated.
      </div>
    );
  }

  const connColor = node.isHub
    ? nodeColor(node)
    : CONNECTIVITY_COLOR[node.connectivity];

  return (
    <div
      className={cn(
        "bg-[var(--panel-2)] border border-[var(--border)] rounded-xl p-3.5"
      )}
    >
      <span
        className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold mb-2"
        style={{ background: connColor + "22", color: connColor }}
      >
        {TYPE_LABEL[node.type]}
      </span>
      <h3 className="my-1 mb-2.5 text-sm break-words font-semibold">
        {node.label}
      </h3>
      <div className="text-[var(--text-secondary)] mb-3 leading-relaxed">
        {node.summary}
      </div>

      <div className="grid grid-cols-[110px_1fr] gap-x-2.5 gap-y-[5px] text-[12.5px]">
        {!node.isHub && (
          <>
            <span className="text-[var(--muted)] font-medium">Connectivity</span>
            <span style={{ color: connColor }}>
              {CONNECTIVITY_LABEL[node.connectivity]}
            </span>
          </>
        )}
        <span className="text-[var(--muted)] font-medium">Direct links</span>
        <span>{node.directDegree}</span>
        <span className="text-[var(--muted)] font-medium">Total edges</span>
        <span>{node.degree}</span>
        {node.poolName && (
          <>
            <span className="text-[var(--muted)] font-medium">Pool</span>
            <span>{node.poolName}</span>
          </>
        )}
        {node.tokens.length > 0 && (
          <>
            <span className="text-[var(--muted)] font-medium">Tokens</span>
            <span>{node.tokens.join(", ")}</span>
          </>
        )}
        {node.timestamp > 0 && (
          <>
            <span className="text-[var(--muted)] font-medium">Time</span>
            <span>
              {new Date(node.timestamp).toLocaleString()}
            </span>
          </>
        )}
        {Object.entries(node.meta)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (
            <Fragment key={k}>
              <span className="text-[var(--muted)] font-medium">{k}</span>
              <span className="break-words">{String(v)}</span>
            </Fragment>
          ))}
      </div>

      <div className="mt-3">
        <div className="text-2xs uppercase tracking-[0.08em] text-[var(--muted)] mb-2.5 mt-[18px] font-bold">
          Connections ({neighbors.length})
        </div>
        {neighbors.length === 0 && (
          <div className="text-[var(--muted)] text-[13px] py-8 px-2 text-center leading-relaxed font-medium">
            No connections — this memory is isolated. The agent has not linked
            it to any decision, lesson, pool, cycle, or token.
          </div>
        )}
        {neighbors.map((row) => (
          <div
            key={row.node.id + row.kind}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-[12.5px]",
              "transition-colors duration-150 ease-[var(--ease-out)]",
              "hover:bg-[var(--panel-3)]"
            )}
            onClick={() => onSelect(row.node.id)}
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle"
              style={{ background: nodeColor(row.node) }}
            />
            <span>{row.node.label}</span>
            <span className="text-[var(--muted)] text-[10px] ml-auto">
              {row.strong ? "● " : "○ "}
              {row.kind}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
