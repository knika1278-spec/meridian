import type { Connectivity, MemoryNode, MemoryNodeType } from "./types";

export const CONNECTIVITY_COLOR: Record<Connectivity, string> = {
  linked: "#34d399",
  "cluster-only": "#fbbf24",
  isolated: "#f87171",
};

export const CONNECTIVITY_LABEL: Record<Connectivity, string> = {
  linked: "Linked (direct cross-reference)",
  "cluster-only": "Cluster-only (shares pool/cycle/token)",
  isolated: "Isolated (no connections)",
};

export const HUB_COLOR: Partial<Record<MemoryNodeType, string>> = {
  pool: "#60a5fa",
  cycle: "#a78bfa",
  token: "#f472b6",
};

export const TYPE_LABEL: Record<MemoryNodeType, string> = {
  journal: "Journal entry",
  decision: "Learning decision",
  shadow: "Shadow score",
  outcome: "Outcome",
  lesson: "Lesson",
  position: "Open position",
  closed: "Closed position",
  pool: "Pool (hub)",
  cycle: "Cycle (hub)",
  token: "Token (hub)",
};

export function nodeColor(node: MemoryNode): string {
  if (node.isHub) return HUB_COLOR[node.type] ?? "#94a3b8";
  return CONNECTIVITY_COLOR[node.connectivity];
}

export function nodeRadius(node: MemoryNode): number {
  if (node.isHub) return node.type === "pool" ? 7 : 6;
  return 3 + Math.min(6, node.directDegree * 1.2);
}
