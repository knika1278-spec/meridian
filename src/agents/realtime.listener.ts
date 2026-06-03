import type {
  UserConfig,
  RealtimeEvent,
  RealtimeEventKind,
} from "../types/index.js";
import { HeliusWsClient } from "../tools/helius.tools.js";
import { childLogger, type Logger } from "../utils/logger.js";
import type { RealtimeSignalSnapshotStore } from "../utils/realtime-signal-snapshot.js";

export type RealtimeEventHandler = (event: RealtimeEvent) => void;

export interface RealtimeListenerOptions {
  signalSnapshotStore?: RealtimeSignalSnapshotStore;
}

const DEFAULT_GLOBAL_BUFFER_SIZE = 500;
const DEFAULT_PER_POOL_BUFFER_SIZE = 50;
const DEFAULT_SIGNATURE_BUFFER_SIZE = 1_000;
const DEFAULT_SWAP_SPIKE_WINDOW_MS = 60_000;
const DEFAULT_SWAP_SPIKE_THRESHOLD = 5;
const DEFAULT_SPIKE_THROTTLE_MS = 60_000;

interface ParsedInstruction {
  programId?: string;
  accounts?: string[];
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
  data?: string;
}

interface TxNotification {
  signature?: string;
  slot?: number;
  transaction?: {
    transaction?: {
      message?: {
        accountKeys?: Array<
          { pubkey: string; signer: boolean; writable: boolean } | string
        >;
        instructions?: ParsedInstruction[];
      };
      signatures?: string[];
    };
    meta?: {
      logMessages?: string[];
      innerInstructions?: Array<{ instructions: ParsedInstruction[] }>;
      err?: unknown;
    };
  };
}

interface ClassifiedEvent {
  kind: RealtimeEventKind;
  poolAddress?: string;
  isRelevant: boolean;
}

export class RealtimeListener {
  private readonly config: UserConfig;
  private readonly onEvent: RealtimeEventHandler;
  private readonly log: Logger;
  private readonly signalSnapshotStore: RealtimeSignalSnapshotStore | undefined;
  private client: HeliusWsClient | null = null;
  private subscriptionId: number | null = null;

  private readonly globalBuffer: RealtimeEvent[] = [];
  private readonly perPoolBuffer = new Map<string, RealtimeEvent[]>();
  private readonly seenSignatures = new Set<string>();
  private readonly signatureBuffer: string[] = [];
  private readonly swapTimestampsPerPool = new Map<string, number[]>();
  private readonly lastSpikeAt = new Map<string, number>();

  constructor(
    config: UserConfig,
    onEvent: RealtimeEventHandler,
    options: RealtimeListenerOptions = {},
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.signalSnapshotStore = options.signalSnapshotStore;
    this.log = childLogger("realtime");
  }

  async start(): Promise<void> {
    this.client = new HeliusWsClient({
      wsUrl: this.config.rpc.wsUrl,
      reconnectMaxAttempts: this.config.websocket.reconnectMaxAttempts,
      reconnectBaseDelayMs: this.config.websocket.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.config.websocket.reconnectMaxDelayMs,
    });

    this.client.on("open", () => {
      this.log.info("helius ws connected");
    });
    this.client.on("close", (info) => {
      this.log.warn({ info }, "helius ws closed");
    });
    this.client.on("error", (info) => {
      this.log.error({ info }, "helius ws error");
    });
    this.client.on("message", (msg) => {
      try {
        this.handleMessage(msg);
      } catch (err) {
        this.log.warn({ err }, "failed to handle ws message");
      }
    });

    // Register subscription before starting
    this.subscriptionId = this.client.subscribe("transactionSubscribe", [
      { accountInclude: [this.config.meteora.programId], failed: false },
      {
        commitment: this.config.rpc.commitment,
        encoding: "jsonParsed",
        transactionDetails: "full",
        maxSupportedTransactionVersion: 0,
        showRewards: false,
      },
    ]);

    await this.client.start();
    this.log.info(
      { subscriptionId: this.subscriptionId },
      "realtime listener started",
    );
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.stop();
      } catch (err) {
        this.log.warn({ err }, "error stopping ws client");
      }
      this.client = null;
    }
    this.signalSnapshotStore?.flush();
    this.subscriptionId = null;
  }

  recent(limit = 100): RealtimeEvent[] {
    const n = Math.max(0, Math.min(limit, this.globalBuffer.length));
    return this.globalBuffer.slice(-n);
  }

  recentFor(poolAddress: string, limit = 20): RealtimeEvent[] {
    const buf = this.perPoolBuffer.get(poolAddress);
    if (!buf) return [];
    const n = Math.max(0, Math.min(limit, buf.length));
    return buf.slice(-n);
  }

  private handleMessage(msg: unknown): void {
    // Subscription notifications have shape: { method: 'transactionNotification', params: { result: {...}, subscription: id } }
    const m = msg as {
      method?: string;
      params?: { result?: TxNotification; subscription?: number };
    };
    if (!m || m.method !== "transactionNotification") return;
    const notif = m.params?.result;
    if (!notif) return;
    const signature =
      notif.signature ?? notif.transaction?.transaction?.signatures?.[0];

    if (this.isDuplicateSignature(signature)) {
      return;
    }

    const classified = this.classify(notif);
    if (!classified.isRelevant) {
      this.log.debug(
        {
          signature,
          slot: notif.slot,
        },
        "ignoring transaction that only mentions the Meteora program",
      );
      return;
    }
    if (classified.kind === "unknown") {
      this.log.debug(
        { signature, slot: notif.slot },
        "ignoring unclassified Meteora transaction",
      );
      return;
    }

    const event: RealtimeEvent = {
      kind: classified.kind,
      poolAddress: classified.poolAddress,
      signature,
      slot: notif.slot,
      timestamp: Date.now(),
    };

    this.recordEvent(event);
    this.maybeEmitSpike(event);

    try {
      this.onEvent(event);
    } catch (err) {
      this.log.warn({ err }, "onEvent handler threw");
    }
  }

  private classify(notif: TxNotification): ClassifiedEvent {
    const programId = this.config.meteora.programId;
    const message = notif.transaction?.transaction?.message;
    const meta = notif.transaction?.meta;
    const logs = meta?.logMessages ?? [];

    const allIxs: ParsedInstruction[] = [];
    if (message?.instructions) allIxs.push(...message.instructions);
    if (meta?.innerInstructions) {
      for (const inner of meta.innerInstructions) {
        if (inner.instructions) allIxs.push(...inner.instructions);
      }
    }

    const meteoraIxs = allIxs.filter((ix) => ix.programId === programId);

    // Extract keyword set from instruction parsed.type names and log lines.
    // Anchor emits "Program log: Instruction: <Name>" so log lines are the
    // primary signal for custom programs like DLMM.
    const keywords: string[] = [];
    for (const ix of meteoraIxs) {
      if (typeof ix.parsed === "object" && ix.parsed?.type)
        keywords.push(ix.parsed.type);
    }
    const joinedLogs = logs.join("\n");

    // Normalize: lowercase + strip underscores so snake_case and camelCase
    // both match (e.g. "add_liquidity" and "addLiquidity" both → "addliquidity").
    const normalize = (s: string): string => s.toLowerCase().replace(/_/g, "");
    const haystack =
      keywords.map(normalize).join(" ") + " " + normalize(joinedLogs);
    const matches = (needle: string): boolean =>
      haystack.includes(normalize(needle));
    const isRelevant =
      meteoraIxs.length > 0 || logs.some((line) => line.includes(programId));

    let kind: RealtimeEventKind = "unknown";
    if (
      matches("initializeLbPair") ||
      matches("initializeCustomizablePermissionlessLbPair") ||
      matches("initializePermissionlessLbPair")
    ) {
      kind = "new_pool";
    } else if (
      // Liquidity-add family: any "addLiquidity*" variant, position init
      // (opening a position is value-in), or fee compounding.
      matches("addLiquidity") ||
      matches("addLiquidityByStrategy") ||
      matches("addLiquidityOneSide") ||
      matches("addLiquidityOneSidePrecise") ||
      matches("depositLiquidity") ||
      matches("initializePosition") ||
      matches("compoundFees") ||
      matches("compoundFee")
    ) {
      kind = "liquidity_add";
    } else if (
      // Liquidity-remove family: explicit remove, position close, fee/reward
      // claims (all are value-out from the pool/position).
      matches("removeLiquidity") ||
      matches("removeAllLiquidity") ||
      matches("removeLiquidityByRange") ||
      matches("closePosition") ||
      matches("closePositionIfEmpty") ||
      matches("claimFee") ||
      matches("claimReward") ||
      matches("claimSwapFee") ||
      matches("claimAllSwapFee") ||
      matches("withdrawIneligibleReward") ||
      matches("withdrawProtocolFee")
    ) {
      kind = "liquidity_remove";
    } else if (matches("swap")) {
      kind = "swap";
    } else if (
      matches("active_id") ||
      matches("active_bin_id") ||
      matches("activeId")
    ) {
      kind = "active_bin_change";
    }

    const poolAddress = this.extractPoolAddress(
      meteoraIxs,
      message?.accountKeys,
    );

    return { kind, poolAddress, isRelevant };
  }

  private extractPoolAddress(
    meteoraIxs: ParsedInstruction[],
    accountKeys:
      | Array<{ pubkey: string; signer: boolean; writable: boolean } | string>
      | undefined,
  ): string | undefined {
    if (!accountKeys || accountKeys.length === 0) return undefined;

    // Build a quick lookup for writable/signer status
    const keyInfo = new Map<string, { signer: boolean; writable: boolean }>();
    for (const k of accountKeys) {
      if (typeof k === "string") {
        keyInfo.set(k, { signer: false, writable: true });
      } else {
        keyInfo.set(k.pubkey, { signer: k.signer, writable: k.writable });
      }
    }

    for (const ix of meteoraIxs) {
      if (!ix.accounts) continue;
      for (const acc of ix.accounts) {
        const info = keyInfo.get(acc);
        if (info && info.writable && !info.signer) {
          return acc;
        }
      }
    }
    return undefined;
  }

  private recordEvent(event: RealtimeEvent): void {
    const globalBufferSize =
      this.config.websocket.globalBufferSize ?? DEFAULT_GLOBAL_BUFFER_SIZE;
    const perPoolBufferSize =
      this.config.websocket.perPoolBufferSize ?? DEFAULT_PER_POOL_BUFFER_SIZE;

    this.globalBuffer.push(event);
    if (this.globalBuffer.length > globalBufferSize) {
      this.globalBuffer.splice(0, this.globalBuffer.length - globalBufferSize);
    }

    if (event.poolAddress) {
      let buf = this.perPoolBuffer.get(event.poolAddress);
      if (!buf) {
        buf = [];
        this.perPoolBuffer.set(event.poolAddress, buf);
      }
      buf.push(event);
      if (buf.length > perPoolBufferSize) {
        buf.splice(0, buf.length - perPoolBufferSize);
      }
    }

    this.signalSnapshotStore?.record(event);
  }

  private isDuplicateSignature(signature: string | undefined): boolean {
    const signatureBufferSize =
      this.config.websocket.signatureBufferSize ??
      DEFAULT_SIGNATURE_BUFFER_SIZE;

    if (!signature) return false;
    if (this.seenSignatures.has(signature)) return true;

    this.seenSignatures.add(signature);
    this.signatureBuffer.push(signature);

    while (this.signatureBuffer.length > signatureBufferSize) {
      const old = this.signatureBuffer.shift();
      if (old) this.seenSignatures.delete(old);
    }
    return false;
  }

  private maybeEmitSpike(event: RealtimeEvent): void {
    if (event.kind !== "swap" || !event.poolAddress) return;
    const pool = event.poolAddress;
    const now = event.timestamp;
    const spikeWindowMs =
      this.config.websocket.spikeWindowMs ?? DEFAULT_SWAP_SPIKE_WINDOW_MS;
    const spikeThreshold =
      this.config.websocket.spikeThreshold ?? DEFAULT_SWAP_SPIKE_THRESHOLD;
    const spikeThrottleMs =
      this.config.websocket.spikeThrottleMs ?? DEFAULT_SPIKE_THROTTLE_MS;

    let timestamps = this.swapTimestampsPerPool.get(pool);
    if (!timestamps) {
      timestamps = [];
      this.swapTimestampsPerPool.set(pool, timestamps);
    }
    timestamps.push(now);
    const cutoff = now - spikeWindowMs;
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length < spikeThreshold) return;

    const lastSpike = this.lastSpikeAt.get(pool) ?? 0;
    if (now - lastSpike < spikeThrottleMs) return;

    this.lastSpikeAt.set(pool, now);
    const spike: RealtimeEvent = {
      kind: "volume_spike",
      poolAddress: pool,
      timestamp: now,
      metadata: {
        swapCount: timestamps.length,
        windowMs: spikeWindowMs,
      },
    };
    this.recordEvent(spike);
    try {
      this.onEvent(spike);
    } catch (err) {
      this.log.warn({ err }, "onEvent handler threw on spike");
    }
  }
}
