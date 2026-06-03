"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryEdge, MemoryGraph, MemoryNode } from "@/lib/types";
import { type GraphFilters, isNodeVisible } from "@/lib/filters";
import { nodeColor, nodeRadius } from "@/lib/visual";

// react-force-graph-2d is canvas/client only — never SSR it.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
}) as unknown as React.ComponentType<Record<string, unknown>>;

interface Props {
  graph: MemoryGraph;
  filters: GraphFilters;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  searchQuery: string;
}

type FGNode = MemoryNode & { x?: number; y?: number };

export default function MemoryGraph({
  graph,
  filters,
  selectedId,
  onSelect,
  searchQuery,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<{
    zoomToFit?: (ms: number, pad: number) => void;
  } | null>(null);
  const nodeObjects = useRef<Map<string, FGNode>>(new Map());
  const fittedRef = useRef(false);

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build render data; reuse node objects across polls so positions persist.
  const gData = useMemo(() => {
    const visible = graph.nodes.filter((n) => isNodeVisible(n, filters));
    const visibleIds = new Set(visible.map((n) => n.id));
    const seen = new Set<string>();
    const nodes: FGNode[] = visible.map((n) => {
      seen.add(n.id);
      const prev = nodeObjects.current.get(n.id);
      if (prev) {
        Object.assign(prev, n);
        return prev;
      }
      const obj: FGNode = { ...n };
      nodeObjects.current.set(n.id, obj);
      return obj;
    });
    for (const id of [...nodeObjects.current.keys()]) {
      if (!seen.has(id)) nodeObjects.current.delete(id);
    }
    const links = graph.edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({ ...e }));
    return { nodes, links };
  }, [graph, filters]);

  // Adjacency for highlight (selected or hovered).
  const adjacency = useMemo(() => {
    const map = new Map<string, { nodes: Set<string>; links: Set<string> }>();
    const ensure = (id: string) => {
      let v = map.get(id);
      if (!v) {
        v = { nodes: new Set(), links: new Set() };
        map.set(id, v);
      }
      return v;
    };
    for (const e of graph.edges) {
      ensure(e.source).nodes.add(e.target);
      ensure(e.source).links.add(e.id);
      ensure(e.target).nodes.add(e.source);
      ensure(e.target).links.add(e.id);
    }
    return map;
  }, [graph]);

  const focusId = hoverId ?? selectedId;
  const highlight = useMemo(() => {
    if (!focusId) return null;
    const adj = adjacency.get(focusId);
    const nodes = new Set<string>([focusId]);
    const links = new Set<string>();
    if (adj) {
      for (const n of adj.nodes) nodes.add(n);
      for (const l of adj.links) links.add(l);
    }
    return { nodes, links };
  }, [focusId, adjacency]);

  const matched = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const set = new Set<string>();
    for (const n of graph.nodes) {
      if (
        n.label.toLowerCase().includes(q) ||
        n.summary.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        (n.poolName ?? "").toLowerCase().includes(q)
      ) {
        set.add(n.id);
      }
    }
    return set;
  }, [searchQuery, graph]);

  // Fit view once after first non-empty data render.
  useEffect(() => {
    if (fittedRef.current || gData.nodes.length === 0) return;
    fittedRef.current = true;
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(500, 60), 400);
    return () => clearTimeout(t);
  }, [gData.nodes.length]);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <ForceGraph2D
        ref={fgRef as never}
        width={size.w}
        height={size.h}
        graphData={gData}
        backgroundColor="#0b0f17"
        cooldownTicks={120}
        d3VelocityDecay={0.3}
        nodeRelSize={1}
        onNodeClick={(node: FGNode) => onSelect(node.id)}
        onNodeHover={(node: FGNode | null) => setHoverId(node ? node.id : null)}
        onBackgroundClick={() => onSelect(null)}
        linkColor={(link: MemoryEdge) => {
          if (highlight && !highlight.links.has(link.id)) {
            return "rgba(80,90,110,0.05)";
          }
          return link.strong
            ? "rgba(160,170,190,0.55)"
            : "rgba(120,130,150,0.16)";
        }}
        linkWidth={(link: MemoryEdge) =>
          highlight && highlight.links.has(link.id) ? 2 : link.strong ? 1 : 0.5
        }
        linkDirectionalParticles={(link: MemoryEdge) =>
          highlight && highlight.links.has(link.id) && link.strong ? 2 : 0
        }
        linkDirectionalParticleWidth={2}
        nodePointerAreaPaint={(
          node: FGNode,
          color: string,
          ctx: CanvasRenderingContext2D,
        ) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(
            node.x ?? 0,
            node.y ?? 0,
            nodeRadius(node) + 2,
            0,
            2 * Math.PI,
          );
          ctx.fill();
        }}
        nodeCanvasObject={(
          node: FGNode,
          ctx: CanvasRenderingContext2D,
          globalScale: number,
        ) => {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const r = nodeRadius(node);
          const dimmed =
            (highlight && !highlight.nodes.has(node.id)) ||
            (matched && !matched.has(node.id));
          ctx.globalAlpha = dimmed ? 0.12 : 1;

          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = nodeColor(node);
          ctx.fill();

          if (node.id === selectedId) {
            ctx.lineWidth = 2 / globalScale;
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();
          } else if (matched && matched.has(node.id)) {
            ctx.lineWidth = 1.5 / globalScale;
            ctx.strokeStyle = "#fde68a";
            ctx.stroke();
          }

          const showLabel =
            node.isHub ||
            node.id === selectedId ||
            node.id === hoverId ||
            (matched ? matched.has(node.id) : globalScale > 2.4);
          if (showLabel) {
            const fontSize = Math.max(9 / globalScale, 2.5);
            ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = "rgba(230,237,246,0.9)";
            ctx.fillText(node.label, x, y + r + 1);
          }
          ctx.globalAlpha = 1;
        }}
      />
    </div>
  );
}
