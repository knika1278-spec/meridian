import type {
  Connectivity,
  EdgeKind,
  GraphStats,
  MemoryEdge,
  MemoryGraph,
  MemoryNode,
  MemoryNodeType,
} from "./types";
import { loadRawData, type RawData, type RawPosition } from "./data-source";

const QUOTE_TOKENS = new Set([
  "SOL",
  "WSOL",
  "USDC",
  "USDT",
  "USDH",
  "USD",
  "USDS",
  "UXD",
  "PYUSD",
  "USDE",
  "USD1",
]);

class GraphBuilder {
  private readonly nodes = new Map<string, MemoryNode>();
  private readonly edges = new Map<string, MemoryEdge>();

  addNode(node: Omit<MemoryNode, "degree" | "directDegree" | "connectivity">) {
    const existing = this.nodes.get(node.id);
    if (existing) {
      if (!existing.poolAddress && node.poolAddress) {
        existing.poolAddress = node.poolAddress;
      }
      if (!existing.poolName && node.poolName)
        existing.poolName = node.poolName;
      if (existing.tokens.length === 0 && node.tokens.length > 0) {
        existing.tokens = node.tokens;
      }
      return existing;
    }
    const full: MemoryNode = {
      ...node,
      degree: 0,
      directDegree: 0,
      connectivity: "isolated",
    };
    this.nodes.set(node.id, full);
    return full;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  get(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  /** Snapshot of current nodes (safe to add hubs while iterating the copy). */
  snapshotNodes(): MemoryNode[] {
    return [...this.nodes.values()];
  }

  addEdge(
    source: string,
    target: string,
    kind: EdgeKind,
    strong: boolean,
    label?: string,
  ) {
    if (source === target) return;
    if (!this.nodes.has(source) || !this.nodes.has(target)) return;
    const id = `${kind}:${source}->${target}`;
    if (this.edges.has(id)) return;
    this.edges.set(id, { id, source, target, kind, strong, label });
  }

  finalize(dataDir: string, warnings: string[]): MemoryGraph {
    for (const edge of this.edges.values()) {
      const s = this.nodes.get(edge.source)!;
      const t = this.nodes.get(edge.target)!;
      s.degree += 1;
      t.degree += 1;
      if (edge.strong) {
        s.directDegree += 1;
        t.directDegree += 1;
      }
    }
    for (const node of this.nodes.values()) {
      node.connectivity = node.isHub
        ? "linked"
        : classify(node.degree, node.directDegree);
    }
    const nodes = [...this.nodes.values()];
    const edges = [...this.edges.values()];
    return {
      generatedAt: Date.now(),
      dataDir,
      nodes,
      edges,
      stats: computeStats(nodes, edges),
      warnings,
    };
  }
}

function classify(degree: number, directDegree: number): Connectivity {
  if (degree === 0) return "isolated";
  if (directDegree === 0) return "cluster-only";
  return "linked";
}

function tokensFromPoolName(name: string | undefined): string[] {
  return (name ?? "")
    .split(/[-/]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function specTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !QUOTE_TOKENS.has(t.toUpperCase()));
}

function shortLabel(value: string): string {
  return value.length > 24 ? `${value.slice(0, 22)}…` : value;
}

export function buildGraph(raw: RawData = loadRawData()): MemoryGraph {
  const b = new GraphBuilder();

  const ensureDecisionStub = (id: string) => {
    if (b.has(id)) return;
    b.addNode({
      id,
      type: "decision",
      label: shortLabel(id),
      timestamp: 0,
      tokens: [],
      summary: "decision (referenced, not in current decisions file)",
      meta: { stub: true },
      isHub: false,
    });
  };

  // ---- 1. Memory nodes -----------------------------------------------------

  for (const j of raw.journals) {
    if (!j.id) continue;
    b.addNode({
      id: j.id,
      type: "journal",
      label: shortLabel(j.subject?.poolName ?? j.event ?? j.id),
      timestamp: j.timestamp ?? 0,
      poolAddress: j.subject?.poolAddress,
      poolName: j.subject?.poolName,
      tokens: j.subject?.tokenSymbols ?? [],
      summary: j.summary ?? `${j.actor ?? "?"}/${j.event ?? "?"}`,
      meta: {
        actor: j.actor ?? null,
        event: j.event ?? null,
        action: j.action ?? null,
        status: j.status ?? null,
        dryRun: j.dryRun ?? null,
        firstReason: j.reasons?.[0] ?? null,
        firstRisk: j.risks?.[0] ?? null,
      },
      isHub: false,
    });
  }

  for (const d of raw.decisions) {
    if (!d.id) continue;
    b.addNode({
      id: d.id,
      type: "decision",
      label: shortLabel(d.pool?.name ?? d.id),
      timestamp: d.timestamp ?? 0,
      poolAddress: d.pool?.address,
      poolName: d.pool?.name,
      tokens: tokensFromPoolName(d.pool?.name),
      summary: `${d.kind ?? "decision"} ${d.action ?? "?"}${
        d.confidence != null ? ` (conf ${d.confidence.toFixed(2)})` : ""
      }`,
      meta: {
        kind: d.kind ?? null,
        action: d.action ?? null,
        confidence: d.confidence ?? null,
        cycleId: d.cycleId ?? null,
        pairClass: (d.features?.["pairClass"] as string) ?? null,
      },
      isHub: false,
    });
  }

  for (const s of raw.shadows) {
    if (!s.decisionId) continue;
    ensureDecisionStub(s.decisionId);
    const dNode = b.get(s.decisionId);
    b.addNode({
      id: `shadow:${s.decisionId}`,
      type: "shadow",
      label: `shadow ${shortLabel(dNode?.poolName ?? s.decisionId)}`,
      timestamp: s.generatedAt ?? 0,
      poolAddress: dNode?.poolAddress,
      poolName: dNode?.poolName,
      tokens: dNode?.tokens ?? [],
      summary: s.disagreement
        ? `Shadow ${s.disagreement.shadowRecommendation} vs ${s.disagreement.llmAction} on ${s.bucketKey ?? "?"}`
        : `Shadow score on ${s.bucketKey ?? "?"}`,
      meta: {
        bucketKey: s.bucketKey ?? null,
        expectedScore: s.expectedScore ?? null,
        riskScore: s.riskScore ?? null,
        sampleSize: s.sampleSize ?? null,
        confidence: s.confidence ?? null,
        disagreement: s.disagreement
          ? `${s.disagreement.shadowRecommendation} vs ${s.disagreement.llmAction}`
          : null,
      },
      isHub: false,
    });
  }

  for (const o of raw.outcomes) {
    if (!o.decisionId) continue;
    ensureDecisionStub(o.decisionId);
    const dNode = b.get(o.decisionId);
    b.addNode({
      id: `outcome:${o.decisionId}:${o.horizonMinutes}`,
      type: "outcome",
      label: `outcome ${o.horizonMinutes}m`,
      timestamp: o.evaluatedAt ?? 0,
      poolAddress: dNode?.poolAddress,
      poolName: dNode?.poolName,
      tokens: dNode?.tokens ?? [],
      summary: `${o.kind ?? "outcome"} @${o.horizonMinutes}m score=${
        o.netPnlRiskScore != null ? o.netPnlRiskScore.toFixed(3) : "?"
      }`,
      meta: {
        horizonMinutes: o.horizonMinutes,
        kind: o.kind ?? null,
        netPnlRiskScore: o.netPnlRiskScore ?? null,
      },
      isHub: false,
    });
  }

  for (const l of raw.lessons) {
    if (!l.id) continue;
    b.addNode({
      id: l.id,
      type: "lesson",
      label: shortLabel(l.poolName ?? l.id),
      timestamp: l.timestamp ?? 0,
      poolName: l.poolName,
      tokens: [...tokensFromPoolName(l.poolName), ...(l.tags ?? [])],
      summary: l.ruleForFuture ?? "lesson",
      meta: { tags: (l.tags ?? []).join(", ") || null },
      isHub: false,
    });
  }

  const addPositionNode = (
    p: RawPosition,
    type: MemoryNodeType,
    prefix: string,
    timestamp: number,
    summary: string,
    extraMeta: Record<string, string | number | boolean | null>,
  ) => {
    if (!p.positionPubkey) return;
    b.addNode({
      id: `${prefix}:${p.positionPubkey}`,
      type,
      label: shortLabel(p.poolName ?? p.positionPubkey),
      timestamp,
      poolAddress: p.poolAddress,
      poolName: p.poolName,
      tokens: [p.tokenX?.symbol, p.tokenY?.symbol].filter(
        (t): t is string => !!t,
      ),
      summary,
      meta: { positionPubkey: p.positionPubkey, ...extraMeta },
      isHub: false,
    });
  };

  for (const p of raw.positions) {
    addPositionNode(p, "position", "pos", p.openedAt ?? 0, "open position", {
      cycleIdOnEnter: p.cycleIdOnEnter ?? null,
    });
  }
  for (const c of raw.closed) {
    addPositionNode(
      c.position ?? ({} as RawPosition),
      "closed",
      "closed",
      c.closedAt ?? 0,
      `closed: ${c.exitReason ?? "?"}`,
      { pnlUsd: c.pnlUsd ?? null, exitReason: c.exitReason ?? null },
    );
  }

  // ---- 2. Hub factories ----------------------------------------------------

  const ensurePoolHub = (address?: string, name?: string) => {
    if (!address) return undefined;
    const id = `pool:${address}`;
    if (!b.has(id)) {
      b.addNode({
        id,
        type: "pool",
        label: name ?? address.slice(0, 6),
        timestamp: 0,
        poolAddress: address,
        poolName: name,
        tokens: tokensFromPoolName(name),
        summary: `Pool ${name ?? address}`,
        meta: { address },
        isHub: true,
      });
    }
    return id;
  };

  const ensureCycleHub = (cycleId?: string) => {
    if (!cycleId) return undefined;
    const id = `cycle:${cycleId}`;
    if (!b.has(id)) {
      b.addNode({
        id,
        type: "cycle",
        label: `cycle ${cycleId.slice(0, 8)}`,
        timestamp: 0,
        tokens: [],
        summary: `Screening cycle ${cycleId}`,
        meta: { cycleId },
        isHub: true,
      });
    }
    return id;
  };

  const ensureTokenHub = (symbol: string) => {
    const id = `token:${symbol.toUpperCase()}`;
    if (!b.has(id)) {
      b.addNode({
        id,
        type: "token",
        label: symbol.toUpperCase(),
        timestamp: 0,
        tokens: [symbol.toUpperCase()],
        summary: `Token ${symbol.toUpperCase()}`,
        meta: { symbol: symbol.toUpperCase() },
        isHub: true,
      });
    }
    return id;
  };

  // ---- 3. Direct semantic edges -------------------------------------------

  for (const j of raw.journals) {
    if (!j.id) continue;
    const linked = j.linkedIds ?? {};
    if (linked.learningDecisionId) {
      ensureDecisionStub(linked.learningDecisionId);
      b.addEdge(j.id, linked.learningDecisionId, "produces", true, "produces");
    }
    if (linked.lessonId && b.has(linked.lessonId)) {
      b.addEdge(j.id, linked.lessonId, "lesson", true, "lesson");
    }
  }

  for (const s of raw.shadows) {
    if (!s.decisionId) continue;
    const shadowId = `shadow:${s.decisionId}`;
    b.addEdge(shadowId, s.decisionId, "scores", true, "scores");
    for (const ev of s.topEvidence ?? []) {
      if (!ev.decisionId) continue;
      ensureDecisionStub(ev.decisionId);
      b.addEdge(shadowId, ev.decisionId, "evidence", true, "cohort evidence");
    }
  }

  for (const o of raw.outcomes) {
    if (!o.decisionId) continue;
    b.addEdge(
      `outcome:${o.decisionId}:${o.horizonMinutes}`,
      o.decisionId,
      "outcome",
      true,
      "outcome of",
    );
  }

  // ---- 4. Membership (weak) edges -----------------------------------------

  for (const node of b.snapshotNodes()) {
    if (node.isHub) continue;
    const poolHub = ensurePoolHub(node.poolAddress, node.poolName);
    if (poolHub) b.addEdge(node.id, poolHub, "pool", false);
    for (const tok of specTokens(node.tokens)) {
      b.addEdge(node.id, ensureTokenHub(tok), "token", false);
    }
  }

  for (const j of raw.journals) {
    const cycleId = j.linkedIds?.cycleId ?? j.linkedIds?.cycleIdOnEnter;
    const hub = ensureCycleHub(cycleId);
    if (hub && j.id && b.has(j.id)) b.addEdge(j.id, hub, "cycle", false);
  }
  for (const d of raw.decisions) {
    const hub = ensureCycleHub(d.cycleId);
    if (hub && d.id && b.has(d.id)) b.addEdge(d.id, hub, "cycle", false);
  }
  for (const p of raw.positions) {
    const hub = ensureCycleHub(p.cycleIdOnEnter);
    const id = `pos:${p.positionPubkey}`;
    if (hub && b.has(id)) b.addEdge(id, hub, "cycle", false);
  }

  return b.finalize(raw.dataDir, raw.warnings);
}

function computeStats(nodes: MemoryNode[], edges: MemoryEdge[]): GraphStats {
  const byType: Record<string, number> = {};
  let memories = 0;
  let hubs = 0;
  let linked = 0;
  let clusterOnly = 0;
  let isolated = 0;
  for (const n of nodes) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    if (n.isHub) {
      hubs += 1;
      continue;
    }
    memories += 1;
    if (n.connectivity === "linked") linked += 1;
    else if (n.connectivity === "cluster-only") clusterOnly += 1;
    else isolated += 1;
  }
  return {
    total: nodes.length,
    memories,
    hubs,
    linked,
    clusterOnly,
    isolated,
    byType,
    edges: edges.length,
    strongEdges: edges.filter((e) => e.strong).length,
  };
}
