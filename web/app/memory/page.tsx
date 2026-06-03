"use client";

import { useState } from "react";
import MemoryGraph from "@/components/MemoryGraph";
import NodeDetail from "@/components/NodeDetail";
import type { MemoryGraph as MemoryGraphData } from "@/lib/types";
import { DEFAULT_FILTERS, type GraphFilters } from "@/lib/filters";
import { CONNECTIVITY_COLOR, HUB_COLOR } from "@/lib/visual";
import { useLiveData } from "@/lib/use-live-data";
import { LiveControls } from "@/components/ui";
import { cn } from "@/lib/cn";

export default function MemoryPage() {
  const {
    data: graph,
    error,
    lastUpdated,
    live,
    setLive,
    reload,
  } = useLiveData<MemoryGraphData>("/api/memory-graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");

  const stats = graph?.stats;

  return (
    <div className="h-screen grid grid-cols-[1fr_340px] grid-rows-[auto_1fr]">
      {/* Header */}
      <header className="col-span-2 flex items-center gap-3.5 px-[18px] py-3.5 border-b border-[var(--border)]">
        <h1 className="text-[17px] m-0 font-bold tracking-tight">🧠 Agent Memory Graph</h1>
        <div className="flex-1" />
        <input
          className={cn(
            "bg-[var(--panel-2)] border border-[var(--border)] rounded-10",
            "text-[var(--text)] px-3 py-[9px] text-[13px] font-sans",
            "transition-all duration-150 ease-[var(--ease-out)]",
            "focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]",
            "placeholder:text-[var(--muted)]",
            "max-w-60 w-full"
          )}
          placeholder="search memory / pool / token…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <LiveControls
          live={live}
          setLive={setLive}
          reload={reload}
          lastUpdated={lastUpdated}
          error={error}
        />
      </header>

      {/* Graph area */}
      <div className="relative overflow-hidden">
        {graph ? (
          <MemoryGraph
            graph={graph}
            filters={filters}
            selectedId={selectedId}
            onSelect={setSelectedId}
            searchQuery={search}
          />
        ) : (
          <div className="text-[var(--muted)] text-[13px] pt-20 text-center font-medium">
            {error ? `Could not load: ${error}` : "Loading memory…"}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="border-l border-[var(--border)] bg-[var(--panel)] overflow-y-auto p-4">
        {stats && graph && (
          <>
            <div className="flex gap-2 flex-wrap">
              <div
                className={cn(
                  "bg-[var(--panel-2)] border border-[var(--border)] rounded-10",
                  "px-3 py-2 min-w-[68px]",
                  "transition-border-color duration-150 ease-[var(--ease-out)]",
                  "hover:border-[var(--border-hover)]"
                )}
              >
                <div className="text-lg font-bold leading-[1.1] tracking-tight tabular-nums">
                  {stats.memories}
                </div>
                <div className="text-2xs uppercase text-[var(--muted)] font-semibold">
                  memories
                </div>
              </div>
              <div
                className={cn(
                  "bg-[var(--panel-2)] border border-[var(--border)] rounded-10",
                  "px-3 py-2 min-w-[68px]",
                  "transition-border-color duration-150 ease-[var(--ease-out)]",
                  "hover:border-[var(--border-hover)]"
                )}
              >
                <div className="text-lg font-bold leading-[1.1] tracking-tight tabular-nums text-linked">
                  {stats.linked}
                </div>
                <div className="text-2xs uppercase text-[var(--muted)] font-semibold">
                  linked
                </div>
              </div>
              <div
                className={cn(
                  "bg-[var(--panel-2)] border border-[var(--border)] rounded-10",
                  "px-3 py-2 min-w-[68px]",
                  "transition-border-color duration-150 ease-[var(--ease-out)]",
                  "hover:border-[var(--border-hover)]"
                )}
              >
                <div className="text-lg font-bold leading-[1.1] tracking-tight tabular-nums text-cluster">
                  {stats.clusterOnly}
                </div>
                <div className="text-2xs uppercase text-[var(--muted)] font-semibold">
                  cluster
                </div>
              </div>
              <div
                className={cn(
                  "bg-[var(--panel-2)] border border-[var(--border)] rounded-10",
                  "px-3 py-2 min-w-[68px]",
                  "transition-border-color duration-150 ease-[var(--ease-out)]",
                  "hover:border-[var(--border-hover)]"
                )}
              >
                <div className="text-lg font-bold leading-[1.1] tracking-tight tabular-nums text-isolated">
                  {stats.isolated}
                </div>
                <div className="text-2xs uppercase text-[var(--muted)] font-semibold">
                  isolated
                </div>
              </div>
            </div>

            <div className="text-2xs uppercase tracking-[0.08em] text-[var(--muted)] mt-[18px] mb-2.5 font-bold">
              Show / hide
            </div>
            <div className="flex flex-col gap-1.5">
              <FilterRow
                color={CONNECTIVITY_COLOR.linked}
                name="Linked"
                desc="direct cross-reference"
                on={filters.linked}
                onClick={() => setFilters((f) => ({ ...f, linked: !f.linked }))}
              />
              <FilterRow
                color={CONNECTIVITY_COLOR["cluster-only"]}
                name="Cluster-only"
                desc="shares pool / cycle / token"
                on={filters.clusterOnly}
                onClick={() =>
                  setFilters((f) => ({ ...f, clusterOnly: !f.clusterOnly }))
                }
              />
              <FilterRow
                color={CONNECTIVITY_COLOR.isolated}
                name="Isolated"
                desc="no connections"
                on={filters.isolated}
                onClick={() =>
                  setFilters((f) => ({ ...f, isolated: !f.isolated }))
                }
              />
              <FilterRow
                color={HUB_COLOR.pool ?? "#60a5fa"}
                name="Hubs"
                desc="pool / cycle / token groupings"
                on={filters.hubs}
                onClick={() => setFilters((f) => ({ ...f, hubs: !f.hubs }))}
              />
            </div>

            <div className="text-2xs uppercase tracking-[0.08em] text-[var(--muted)] mt-[18px] mb-2.5 font-bold">
              Inspector
            </div>
            <NodeDetail
              graph={graph}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />

            {graph.warnings.length > 0 && (
              <div
                className={cn(
                  "mt-4 text-xs text-warning font-medium",
                  "bg-warning-glow border border-[rgba(251,191,36,0.2)]",
                  "rounded-xl px-4 py-3"
                )}
              >
                {graph.warnings.map((w, i) => (
                  <div key={i}>&#x26A0; {w}</div>
                ))}
              </div>
            )}

            <div className="text-2xs uppercase tracking-[0.08em] text-[var(--muted)] mt-[18px] mb-2.5 font-bold">
              Source
            </div>
            <div className="text-xs text-[var(--muted)] font-medium break-all">
              {graph.dataDir}
              <br />
              {stats.edges} edges &middot; {stats.strongEdges} direct &middot; {stats.hubs}{" "}
              hubs
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function FilterRow({
  color,
  name,
  desc,
  on,
  onClick,
}: {
  color: string;
  name: string;
  desc: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center text-xs cursor-pointer select-none font-medium",
        on ? "text-[var(--muted)]" : "text-[var(--muted)] opacity-40"
      )}
      onClick={onClick}
    >
      <span
        className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle"
        style={{ background: color }}
      />
      <span className="text-[var(--text)] mr-1.5 font-semibold">{name}</span>
      <span>{desc}</span>
    </div>
  );
}
