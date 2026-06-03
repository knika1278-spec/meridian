// Slim, web-local mirror of the agent's memory records. We intentionally do NOT
// import from ../src (different tsconfig + ESM .js specifiers). Only the fields
// the graph needs are declared here.

export type MemoryNodeType =
  | "journal"
  | "decision"
  | "shadow"
  | "outcome"
  | "lesson"
  | "position"
  | "closed"
  | "pool" // hub
  | "cycle" // hub
  | "token"; // hub

export type EdgeKind =
  | "produces" // journal -> learning decision
  | "scores" // shadow -> decision
  | "evidence" // shadow cohort topEvidence -> decision
  | "outcome" // outcome -> decision
  | "lesson" // journal -> lesson
  | "pool" // member -> pool hub
  | "cycle" // member -> cycle hub
  | "token"; // member -> token hub

export type Connectivity = "isolated" | "cluster-only" | "linked";

export interface MemoryNode {
  id: string;
  type: MemoryNodeType;
  label: string;
  timestamp: number;
  poolAddress?: string;
  poolName?: string;
  tokens: string[];
  summary: string;
  meta: Record<string, string | number | boolean | null>;
  isHub: boolean;
  degree: number;
  directDegree: number;
  connectivity: Connectivity;
}

export interface MemoryEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  strong: boolean;
  label?: string;
}

export interface GraphStats {
  total: number;
  memories: number;
  hubs: number;
  linked: number;
  clusterOnly: number;
  isolated: number;
  byType: Record<string, number>;
  edges: number;
  strongEdges: number;
}

export interface MemoryGraph {
  generatedAt: number;
  dataDir: string;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  stats: GraphStats;
  warnings: string[];
}
