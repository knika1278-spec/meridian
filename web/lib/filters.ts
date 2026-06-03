import type { MemoryNode } from "./types";

export interface GraphFilters {
  linked: boolean;
  clusterOnly: boolean;
  isolated: boolean;
  hubs: boolean;
}

export const DEFAULT_FILTERS: GraphFilters = {
  linked: true,
  clusterOnly: true,
  isolated: true,
  hubs: true,
};

export function isNodeVisible(
  node: MemoryNode,
  filters: GraphFilters,
): boolean {
  if (node.isHub) return filters.hubs;
  if (node.connectivity === "linked") return filters.linked;
  if (node.connectivity === "cluster-only") return filters.clusterOnly;
  return filters.isolated;
}
