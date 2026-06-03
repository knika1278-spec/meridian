import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { childLogger } from "../utils/logger.js";
import type {
  DlmmStrategy,
  OpenPositionInput,
  OpenPositionResult,
  Pool,
  Position,
  PositionToken,
} from "../types/index.js";
import type { MeteoraTools } from "./meteora.tools.js";
import type { WalletTools } from "./wallet.tools.js";

const log = childLogger("meteora-actions");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_MINTS = new Set<string>([SOL_MINT, USDC_MINT]);

// ============================================================
//  Public result types
// ============================================================

export interface PositionOnChainState {
  positionPubkey: string;
  poolAddress: string;
  amountX: string;
  amountY: string;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  claimableFeeX: string;
  claimableFeeY: string;
}

export interface CloseResult {
  signature?: string;
  claimSignatures?: string[];
  closeSignatures?: string[];
  receivedX: string;
  receivedY: string;
  claimedFeeX: string;
  claimedFeeY: string;
  dryRun: boolean;
}

export interface CloseEmptyPositionResult {
  signature?: string;
  dryRun: boolean;
  /**
   * Approximate SOL reclaimed (rent refund). LB position accounts cost roughly
   * 0.057 SOL of rent — used as an estimate for reporting; actual reclaim is
   * decided by the runtime when the account is closed.
   */
  reclaimedSolEstimate: number;
}

export interface ClaimResult {
  signature?: string;
  claimedX: string;
  claimedY: string;
  dryRun: boolean;
}

export interface RebalanceResult {
  closeSig?: string;
  openSig?: string;
  newPosition: Position;
  dryRun: boolean;
}

export interface MeteoraActionsOptions {
  connection: Connection;
  wallet: WalletTools;
  meteora: MeteoraTools;
  /**
   * Hard cap on bins-per-side requested when opening a position. Prevents
   * narrow-bin-step pools (binStep 1-5) + wide rangeBps from exceeding the
   * inner-CPI realloc limit (10,240 bytes) on `createEmptyPosition`. The SDK
   * also enforces ~70 bins/position via `DEFAULT_BIN_PER_POSITION`. Default 30.
   */
  maxBinsPerSide?: number;
}

// ============================================================
//  SDK shim helpers (defensive, no `any`)
// ============================================================

type DlmmFactory = (
  connection: Connection,
  pubkey: PublicKey,
) => Promise<DlmmInstance>;

interface ActiveBinShape {
  binId: number;
  price?: number | string;
}

interface PositionBinShape {
  binId: number;
  positionLiquidity?: string | number | BN;
}

interface PositionDataShape {
  positionBinData?: PositionBinShape[];
  totalXAmount?: string | number | BN;
  totalYAmount?: string | number | BN;
  feeX?: string | number | BN;
  feeY?: string | number | BN;
  lowerBinId?: number;
  upperBinId?: number;
}

interface PositionShape {
  positionData?: PositionDataShape;
  publicKey?: PublicKey;
  poolAddress?: PublicKey;
  lbPair?: PublicKey;
}

interface PositionInfoShape {
  lbPairPositionsData?: PositionShape[];
}

interface DlmmInstance {
  pubkey?: PublicKey;
  tokenX?: { publicKey?: PublicKey; mint?: { decimals?: number } };
  tokenY?: { publicKey?: PublicKey; mint?: { decimals?: number } };
  getActiveBin(): Promise<ActiveBinShape>;
  getPosition(pubkey: PublicKey): Promise<PositionShape>;
  initializePositionAndAddLiquidityByStrategy(args: {
    positionPubKey: PublicKey;
    user: PublicKey;
    totalXAmount: BN;
    totalYAmount: BN;
    strategy: { minBinId: number; maxBinId: number; strategyType: number };
  }): Promise<Transaction | Transaction[]>;
  /**
   * v1.9+ split-flow: creates the position account as a top-level tx so
   * realloc gets the full 10 MB limit (not the inner-CPI 10,240-byte cap).
   * Limited to ~70 bins total (DEFAULT_BIN_PER_POSITION). Use
   * createExtendedEmptyPosition for wider ranges.
   */
  createEmptyPosition(args: {
    positionPubKey: PublicKey;
    minBinId: number;
    maxBinId: number;
    user: PublicKey;
  }): Promise<Transaction>;
  /**
   * v1.9+ wide-range init: positional-arg helper that builds a
   * createInitAndExtendPositionIx chain for ranges exceeding the default
   * DEFAULT_BIN_PER_POSITION (~70). Required for narrow bin-step pools with
   * wider ranges.
   */
  createExtendedEmptyPosition?: (
    lowerBinId: number,
    upperBinId: number,
    position: PublicKey,
    owner: PublicKey,
  ) => Promise<Transaction>;
  /**
   * v1.9+ split-flow: adds liquidity to an already-initialized position.
   * Required after createEmptyPosition to fund the bins.
   */
  addLiquidityByStrategy(args: {
    positionPubKey: PublicKey;
    user: PublicKey;
    totalXAmount: BN;
    totalYAmount: BN;
    strategy: { minBinId: number; maxBinId: number; strategyType: number };
    slippage?: number;
  }): Promise<Transaction | Transaction[]>;
  removeLiquidity(args: {
    position: PublicKey;
    user: PublicKey;
    fromBinId: number;
    toBinId: number;
    bps: BN;
    shouldClaimAndClose: boolean;
    skipUnwrapSOL?: boolean;
  }): Promise<Transaction | Transaction[]>;
  claimSwapFee(args: {
    owner: PublicKey;
    position: PositionShape;
  }): Promise<Transaction | Transaction[]>;
  claimAllSwapFee?: (args: {
    owner: PublicKey;
    positions: PositionShape[];
  }) => Promise<Transaction | Transaction[]>;
  /**
   * v1.9+ SDK helper: closes a position ONLY if it has zero liquidity.
   * Required input shape is the LbPosition object returned by `getPosition`
   * (the SDK reads `publicKey` and bin metadata off of `positionData`).
   * Returns a single legacy Transaction.
   */
  closePositionIfEmpty?: (args: {
    owner: PublicKey;
    position: PositionShape;
  }) => Promise<Transaction>;
  closePosition?: (args: {
    owner: PublicKey;
    position: PositionShape;
  }) => Promise<Transaction>;
  /** SDK atomic rebalance: simulate with balanced strategy. */
  simulateRebalancePositionWithBalancedStrategy?: (
    positionAddress: PublicKey,
    positionData: PositionShape,
    strategy: number, // StrategyType enum: 0=Spot, 1=Curve, 2=BidAsk
    topUpAmountX: BN,
    topUpAmountY: BN,
    xWithdrawBps: BN,
    yWithdrawBps: BN,
  ) => Promise<unknown>;
  /** SDK atomic rebalance: build transaction from simulation result. */
  rebalancePosition?: (
    rebalancePositionResponse: unknown,
    maxActiveBinSlippage: number,
    rentPayer: PublicKey,
    slippage?: number,
  ) => Promise<{ instructions?: Transaction[] } | Transaction | Transaction[]>;
}

interface StrategyEnumShape {
  // Legacy "ImBalanced" variants (older SDKs)
  SpotImBalanced?: number;
  BidAskImBalanced?: number;
  CurveImBalanced?: number;
  // Current SDK (v1.9+): plain Spot/Curve/BidAsk are the active variants.
  // Confirmed empirically: { Spot: 0, Curve: 1, BidAsk: 2 }
  Spot?: number;
  BidAsk?: number;
  Curve?: number;
}

function resolveDlmmFactory(mod: unknown): DlmmFactory | null {
  if (!mod) return null;
  const t = typeof mod;
  // Accept both object exports and a function-exported module
  // (DLMM v1.9+ sets `module.exports = create`).
  if (t !== "object" && t !== "function") return null;
  const m = mod as Record<string, unknown>;
  const candidates: unknown[] = [
    (m.default as Record<string, unknown> | undefined)?.create,
    m.create,
    (m.DLMM as Record<string, unknown> | undefined)?.create,
    m.default,
    m.DLMM,
    // v1.9+: the module export IS the `create` function itself.
    t === "function" ? mod : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "function") {
      return c as DlmmFactory;
    }
  }
  return null;
}

interface DlmmStaticShape {
  getAllLbPairPositionsByUser?: (
    connection: Connection,
    userPubKey: PublicKey,
  ) => Promise<Map<string, PositionInfoShape>>;
}

function resolveDlmmStatic(mod: unknown): DlmmStaticShape | null {
  if (!mod) return null;
  const t = typeof mod;
  if (t !== "object" && t !== "function") return null;
  const m = mod as Record<string, unknown>;
  const candidates: unknown[] = [
    mod,
    m.default,
    m.DLMM,
    (m.default as Record<string, unknown> | undefined)?.DLMM,
  ];
  for (const c of candidates) {
    if (!c || (typeof c !== "object" && typeof c !== "function")) continue;
    const maybe = c as DlmmStaticShape;
    if (typeof maybe.getAllLbPairPositionsByUser === "function") {
      return maybe;
    }
  }
  return null;
}

function resolveStrategyType(mod: unknown, strategy: DlmmStrategy): number {
  // Prefer the live SDK enum to avoid hard-coding ordinals.
  if (mod && (typeof mod === "object" || typeof mod === "function")) {
    const m = mod as Record<string, unknown>;
    const candidates: unknown[] = [
      m.StrategyType,
      (m.default as Record<string, unknown> | undefined)?.StrategyType,
    ];
    for (const e of candidates) {
      if (e && typeof e === "object") {
        const enumObj = e as StrategyEnumShape;
        // Prefer current (non-deprecated) Spot/Curve/BidAsk first. The
        // legacy "*ImBalanced" ordinals (6/7/8) are NOT valid in v1.9+ and
        // produce AnchorError 6054 (InvalidStrategyParameters).
        if (strategy === "Spot") {
          if (typeof enumObj.Spot === "number") return enumObj.Spot;
          if (typeof enumObj.SpotImBalanced === "number")
            return enumObj.SpotImBalanced;
        } else if (strategy === "BidAsk") {
          if (typeof enumObj.BidAsk === "number") return enumObj.BidAsk;
          if (typeof enumObj.BidAskImBalanced === "number")
            return enumObj.BidAskImBalanced;
        } else if (strategy === "Curve") {
          if (typeof enumObj.Curve === "number") return enumObj.Curve;
          if (typeof enumObj.CurveImBalanced === "number")
            return enumObj.CurveImBalanced;
        }
      }
    }
  }
  // Fallback for current SDK: Spot=0, Curve=1, BidAsk=2.
  if (strategy === "Spot") return 0;
  if (strategy === "Curve") return 1;
  return 2;
}

async function loadDlmmModule(): Promise<unknown> {
  // Use CJS resolution to bypass the @coral-xyz/anchor ESM directory-import
  // bug. See src/tools/dlmm-loader.ts for the full rationale.
  const { loadDlmmSdk } = await import("./dlmm-loader.js");
  return loadDlmmSdk();
}

async function getDlmmInstance(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<{ instance: DlmmInstance; mod: unknown }> {
  const mod = await loadDlmmModule();
  const factory = resolveDlmmFactory(mod);
  if (!factory) {
    throw new Error("DLMM SDK factory not found (cannot resolve DLMM.create)");
  }
  const instance = await factory(connection, poolAddress);
  return { instance, mod };
}

// ============================================================
//  Value coercion helpers
// ============================================================

function toBnString(value: unknown): string {
  if (value === undefined || value === null) return "0";
  if (BN.isBN(value)) return (value as BN).toString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "0";
  }
  return "0";
}

function tokenToPositionToken(t: Pool["tokenX"]): PositionToken {
  return { mint: t.mint, symbol: t.symbol, decimals: t.decimals };
}

/**
 * Pick the single side to deposit into. The bot funds positions only from the
 * quote it holds (SOL/USDC), and the XOR whitelist guarantees exactly one pool
 * side is a quote token. Returns the side to deposit ("X" or "Y"); the opposite
 * side is left at zero for single-sided liquidity.
 */
function resolveDepositSide(pool: Pool): "X" | "Y" {
  const xQuote = QUOTE_MINTS.has(pool.tokenX.mint);
  const yQuote = QUOTE_MINTS.has(pool.tokenY.mint);
  if (yQuote && !xQuote) return "Y";
  if (xQuote && !yQuote) return "X";
  // Dual-quote pool (e.g. SOL/USDC) — prefer the SOL side.
  if (xQuote && yQuote) {
    return pool.tokenX.mint === SOL_MINT ? "X" : "Y";
  }
  // Neither side is a recognized quote: single-sided needs a known quote to
  // deposit. Surface a clear error rather than silently demanding the base.
  throw new Error(
    `openPosition: cannot determine single-sided deposit token for ${pool.name} ` +
      `(neither side is SOL/USDC: X=${pool.tokenX.symbol}, Y=${pool.tokenY.symbol}). ` +
      "Enable a swap-to-base flow to LP this pool.",
  );
}

function rawFromUsd(usd: number, priceUsd: number, decimals: number): BN {
  if (
    !Number.isFinite(usd) ||
    usd <= 0 ||
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0
  ) {
    return new BN(0);
  }
  const raw = Math.floor((usd / priceUsd) * Math.pow(10, decimals));
  return new BN(raw.toString());
}

async function sendTxs(
  wallet: WalletTools,
  txs: Transaction | Transaction[],
  opts: { dryRun?: boolean; extraSigners?: Keypair[]; computeUnitPrice?: number },
): Promise<string | undefined> {
  const signatures = await sendTxList(wallet, txs, opts);
  return signatures[signatures.length - 1];
}

async function sendTxList(
  wallet: WalletTools,
  txs: Transaction | Transaction[],
  opts: { dryRun?: boolean; extraSigners?: Keypair[]; computeUnitPrice?: number },
): Promise<string[]> {
  const list: Transaction[] = Array.isArray(txs) ? txs : [txs];
  const signatures: string[] = [];
  for (const tx of list) {
    const res = await wallet.signAndSend(
      tx as Transaction | VersionedTransaction,
      {
        dryRun: opts.dryRun,
        extraSigners: opts.extraSigners,
        computeUnitPrice: opts.computeUnitPrice,
      },
    );
    if (res.simulationError && opts.dryRun) {
      log.warn({ err: res.simulationError }, "dry-run simulation error");
    }
    signatures.push(res.signature);
  }
  return signatures;
}

// ============================================================
//  MeteoraActions
// ============================================================

// Default cap for bins-per-side. The SDK's createEmptyPosition uses
// `initializePosition` which can only allocate up to DEFAULT_BIN_PER_POSITION
// (~70 total) in a single call before hitting the 10,240-byte inner-CPI
// realloc limit. 30 per side = 61 total, comfortably under.
const DEFAULT_MAX_BINS_PER_SIDE = 30;

export class MeteoraActions {
  private readonly connection: Connection;
  private readonly wallet: WalletTools;
  private readonly meteora: MeteoraTools;
  private readonly maxBinsPerSide: number;

  constructor(opts: MeteoraActionsOptions) {
    this.connection = opts.connection;
    this.wallet = opts.wallet;
    this.meteora = opts.meteora;
    this.maxBinsPerSide =
      typeof opts.maxBinsPerSide === "number" && opts.maxBinsPerSide > 0
        ? Math.floor(opts.maxBinsPerSide)
        : DEFAULT_MAX_BINS_PER_SIDE;
  }

  private requireWallet(method: string, dryRun: boolean): void {
    if (!this.wallet.isConfigured() && !dryRun)
      throw new Error(
        `${method}: wallet not configured and dryRun=false; cannot send`,
      );
  }

  // ---------- openPosition ----------
  async openPosition(input: OpenPositionInput): Promise<OpenPositionResult> {
    if (input.sizeUsd <= 0) {
      throw new Error("openPosition: sizeUsd must be > 0");
    }
    if (input.rangeBps <= 0) {
      throw new Error("openPosition: rangeBps must be > 0");
    }
    const strategy: DlmmStrategy = input.strategy ?? "Spot";
    const dryRun = input.dryRun === true;

    const pool = await this.meteora.fetchPairByAddress(input.poolAddress);
    if (!pool) {
      throw new Error(
        `openPosition: pool not found via Meteora API: ${input.poolAddress}`,
      );
    }
    if (!pool.binStep || pool.binStep <= 0) {
      throw new Error(
        `openPosition: pool ${input.poolAddress} has invalid binStep`,
      );
    }

    const poolPk = new PublicKey(input.poolAddress);
    const { instance: dlmm, mod } = await getDlmmInstance(
      this.connection,
      poolPk,
    );

    const active = await dlmm.getActiveBin();
    const activeBinId =
      typeof active?.binId === "number" ? active.binId : pool.activeBinId;

    // Adaptive bin cap: narrow bin-step pools (binStep 1-5) with wide rangeBps
    // generate huge bin counts (e.g. rangeBps=400, binStep=1 → 200 bins/side =
    // 401 total) that exceed the inner-CPI realloc cap on createEmptyPosition.
    const requestedBinsPerSide = Math.max(
      1,
      Math.round(input.rangeBps / 2 / pool.binStep),
    );
    const binsPerSide = Math.min(requestedBinsPerSide, this.maxBinsPerSide);
    if (binsPerSide < requestedBinsPerSide) {
      log.info(
        {
          pool: input.poolAddress,
          requestedBinsPerSide,
          capped: binsPerSide,
          binStep: pool.binStep,
          maxBinsPerSide: this.maxBinsPerSide,
        },
        "bin range capped by maxBinsPerSide",
      );
    }
    // Single-sided deposit: the bot only holds quote (SOL/USDC), so it deposits
    // ONE token and places bins on that token's side of the active bin. DLMM
    // bin composition: bins below the active bin hold only quote token Y; bins
    // above hold only base token X. A range that straddles the active bin would
    // require BOTH tokens — the cause of prior "Missing X:<base>" open failures.
    // We confine the range to the deposit token's side, active bin inclusive so
    // the position starts in-range.
    const depositSide = resolveDepositSide(pool);

    let lowerBinId: number;
    let upperBinId: number;
    if (depositSide === "Y") {
      lowerBinId = activeBinId - binsPerSide;
      upperBinId = activeBinId + 2; // Fix 4: +2 bin upside buffer so position isn't OOR on first tick up
    } else {
      lowerBinId = activeBinId;
      upperBinId = activeBinId + binsPerSide;
    }

    // Fix 4 guard: if the active bin is at or above the upper boundary
    // (can occur when binsPerSide is tiny or rounding collapses the range),
    // the position would be immediately OOR — reject it hard.
    if (activeBinId >= upperBinId - 1) {
      throw new Error(
        `openPosition: bin-buffer guard triggered — activeBinId ${activeBinId} >= upperBinId-1 ${upperBinId - 1}; range too narrow, aborting open`,
      );
    }

    // Full sizeUsd goes into the deposit token; the opposite side stays 0.
    // Fall back to currentPrice (Y per X) when the deposit side lacks a direct
    // USD price.
    const priceX = pool.tokenX.priceUsd;
    const priceY = pool.tokenY.priceUsd;

    let totalXAmount = new BN(0);
    let totalYAmount = new BN(0);

    if (depositSide === "Y") {
      if (typeof priceY === "number" && priceY > 0) {
        totalYAmount = rawFromUsd(input.sizeUsd, priceY, pool.tokenY.decimals);
      } else if (
        typeof priceX === "number" &&
        priceX > 0 &&
        pool.currentPrice > 0
      ) {
        const priceYFallback = priceX / pool.currentPrice;
        totalYAmount = rawFromUsd(
          input.sizeUsd,
          priceYFallback,
          pool.tokenY.decimals,
        );
      }
    } else {
      if (typeof priceX === "number" && priceX > 0) {
        totalXAmount = rawFromUsd(input.sizeUsd, priceX, pool.tokenX.decimals);
      } else if (
        typeof priceY === "number" &&
        priceY > 0 &&
        pool.currentPrice > 0
      ) {
        // currentPrice = Y per X → priceX ≈ priceY * currentPrice
        totalXAmount = rawFromUsd(
          input.sizeUsd,
          priceY * pool.currentPrice,
          pool.tokenX.decimals,
        );
      }
    }

    const strategyType = resolveStrategyType(mod, strategy);
    const user = this.wallet.isConfigured()
      ? this.wallet.getPublicKey()
      : Keypair.generate().publicKey; // placeholder for unconfigured dry-runs

    const positionKeypair = Keypair.generate();

    log.info(
      {
        pool: input.poolAddress,
        activeBinId,
        lowerBinId,
        upperBinId,
        depositSide,
        strategy,
        totalXAmount: totalXAmount.toString(),
        totalYAmount: totalYAmount.toString(),
        dryRun,
      },
      "opening position",
    );

    this.requireWallet("openPosition", dryRun);
    if (!dryRun) {
      await this.assertWalletCanFundLiquidity(
        user,
        pool,
        totalXAmount,
        totalYAmount,
      );
    }

    // ----------------------------------------------------------------
    //  Split-flow: tx#1 InitializePosition, tx#2 AddLiquidityByStrategy
    // ----------------------------------------------------------------
    // DLMM v2 position accounts exceed 10,240 bytes. Solana caps inner-CPI
    // realloc at 10,240 bytes per tx, so the legacy combined helper
    // (initializePositionAndAddLiquidityByStrategy) fails with InvalidRealloc
    // (`Account data size realloc limited to 10240 in inner instructions`).
    // Splitting into two top-level transactions gives the init step the full
    // 10 MB realloc budget, and the add-liquidity step runs against the
    // already-sized account.
    if (typeof dlmm.addLiquidityByStrategy !== "function") {
      throw new Error(
        "openPosition: DLMM SDK missing addLiquidityByStrategy; cannot use split init/add flow",
      );
    }

    // The SDK's `createEmptyPosition` calls `initializePosition(minBinId, width)`
    // which can only allocate up to DEFAULT_BIN_PER_POSITION (~70 bins). For
    // wider ranges we MUST use `createExtendedEmptyPosition` (which chains
    // initialize + extend ixs). Total bin count = upper - lower + 1.
    const totalBins = upperBinId - lowerBinId + 1;
    const useExtended = totalBins > 70;

    if (useExtended && typeof dlmm.createExtendedEmptyPosition !== "function") {
      throw new Error(
        `openPosition: position width ${totalBins} > 70 bins requires createExtendedEmptyPosition but SDK does not expose it`,
      );
    }
    if (!useExtended && typeof dlmm.createEmptyPosition !== "function") {
      throw new Error(
        "openPosition: DLMM SDK missing createEmptyPosition; cannot use split init/add flow",
      );
    }

    // ---- tx#1: InitializePosition (top-level realloc, no inner-CPI cap) ----
    const initTx = useExtended
      ? // createExtendedEmptyPosition signature: (lowerBinId, upperBinId, position, owner)
        await dlmm.createExtendedEmptyPosition!(
          lowerBinId,
          upperBinId,
          positionKeypair.publicKey,
          user,
        )
      : await dlmm.createEmptyPosition({
          positionPubKey: positionKeypair.publicKey,
          minBinId: lowerBinId,
          maxBinId: upperBinId,
          user,
        });

    log.info(
      {
        pool: input.poolAddress,
        useExtended,
        totalBins,
        lowerBinId,
        upperBinId,
      },
      "tx#1 init method selected",
    );

    const initSig = await sendTxs(this.wallet, initTx, {
      dryRun,
      extraSigners: [positionKeypair],
      ...(typeof input.priorityFeeLamports === "number"
        ? { computeUnitPrice: input.priorityFeeLamports }
        : {}),
    });

    log.info(
      { position: positionKeypair.publicKey.toBase58(), initSig, dryRun },
      "tx#1 (InitializePosition) sent",
    );

    // CRITICAL: Wait for tx#1 on-chain confirmation before tx#2.
    // `sendTxs` broadcasts without waiting; if tx#2 simulation runs while tx#1
    // is still in-flight the position account is still owned by System Program
    // → Anchor error 3007 (AccountOwnedByWrongProgram).
    if (!dryRun && initSig) {
      log.info({ initSig }, "awaiting tx#1 on-chain confirmation…");
      const latestBlockhash = await this.connection.getLatestBlockhash();
      const confirmation = await this.connection.confirmTransaction(
        { signature: initSig, ...latestBlockhash },
        "confirmed",
      );
      if (confirmation.value.err) {
        throw new Error(
          `tx#1 (InitializePosition) failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      log.info(
        { initSig },
        "tx#1 confirmed — position account now owned by DLMM program",
      );
    }

    // Resolve actual bin range from chain when not dry-run. SDK may
    // adjust/clamp lower/upper internally, and tx#2 strategy params MUST
    // match the on-chain position's actual range or the program rejects with
    // AnchorError 6054 (InvalidStrategyParameters / 0x17a6).
    let actualLowerBinId = lowerBinId;
    let actualUpperBinId = upperBinId;
    if (!dryRun) {
      try {
        const onChainPos = await dlmm.getPosition(positionKeypair.publicKey);
        const pd = onChainPos?.positionData;
        if (pd && typeof pd.lowerBinId === "number") {
          actualLowerBinId = pd.lowerBinId;
        }
        if (pd && typeof pd.upperBinId === "number") {
          actualUpperBinId = pd.upperBinId;
        }
        if (
          actualLowerBinId !== lowerBinId ||
          actualUpperBinId !== upperBinId
        ) {
          log.info(
            {
              requested: { lowerBinId, upperBinId },
              actual: {
                lowerBinId: actualLowerBinId,
                upperBinId: actualUpperBinId,
              },
            },
            "position bin range adjusted by SDK; using on-chain values for tx#2",
          );
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "post-init getPosition failed; using requested bin range for tx#2",
        );
      }
    }

    // Validate amounts BEFORE calling SDK. AddLiquidityByStrategy rejects
    // both-sides-zero, and `Spot` strategy effectively rejects single-side
    // zero on certain pool configurations.
    if (totalXAmount.lten(0) && totalYAmount.lten(0)) {
      throw new Error(
        `openPosition: both totalXAmount and totalYAmount are 0 (sizeUsd=${input.sizeUsd}, priceX=${priceX}, priceY=${priceY}). Position created but liquidity cannot be added.`,
      );
    }

    // ---- tx#2: AddLiquidityByStrategy (position already exists) ----
    let addSig: string | undefined;
    let addError: string | undefined;
    try {
      log.info(
        {
          position: positionKeypair.publicKey.toBase58(),
          totalXAmount: totalXAmount.toString(),
          totalYAmount: totalYAmount.toString(),
          strategyType,
          minBinId: actualLowerBinId,
          maxBinId: actualUpperBinId,
        },
        "tx#2 add-liquidity params",
      );
      const addTxs = await dlmm.addLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user,
        totalXAmount,
        totalYAmount,
        strategy: {
          minBinId: actualLowerBinId,
          maxBinId: actualUpperBinId,
          strategyType,
        },
        // Pass explicit slippage (basis points-style). The SDK converts to
        // maxActiveBinSlippage internally; omitting may default-to-zero in
        // some versions and cause MAX_ACTIVE_BIN_SLIPPAGE failures.
        slippage: 100,
      });
      addSig = await sendTxs(this.wallet, addTxs, {
        dryRun,
        ...(typeof input.priorityFeeLamports === "number"
          ? { computeUnitPrice: input.priorityFeeLamports }
          : {}),
      });
      log.info(
        { position: positionKeypair.publicKey.toBase58(), addSig, dryRun },
        "tx#2 (AddLiquidityByStrategy) sent",
      );
    } catch (err) {
      addError = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          position: positionKeypair.publicKey.toBase58(),
          initSig,
          err: addError,
        },
        "tx#2 (AddLiquidityByStrategy) FAILED — position created but liquidity NOT added. Manual recovery needed via addLiquidity command.",
      );
    }

    // Prefer the add-liquidity signature for the on-chain "the position is
    // fully funded" record; fall back to init sig when add failed.
    const signature = addSig ?? initSig;

    const entryTimestamp = Date.now();
    const recoveryNote =
      addError !== undefined
        ? `PARTIAL: init tx ${initSig ?? "n/a"} succeeded; add-liquidity failed (${addError}). Run manual addLiquidity to fund.`
        : undefined;
    const combinedNotes = [input.notes, recoveryNote]
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .join(" | ");

    const position: Position = {
      positionPubkey: positionKeypair.publicKey.toBase58(),
      poolAddress: input.poolAddress,
      poolName: pool.name,
      tokenX: tokenToPositionToken(pool.tokenX),
      tokenY: tokenToPositionToken(pool.tokenY),
      binStep: pool.binStep,
      lowerBinId: actualLowerBinId,
      upperBinId: actualUpperBinId,
      entryActiveBinId: activeBinId,
      entryPrice: pool.currentPrice,
      entryTimestamp,
      entryAmountX: addError ? "0" : totalXAmount.toString(),
      entryAmountY: addError ? "0" : totalYAmount.toString(),
      entryValueUsd: addError ? 0 : input.sizeUsd,
      strategyType: strategy,
      dryRun,
      ...(input.cycleIdOnEnter ? { cycleIdOnEnter: input.cycleIdOnEnter } : {}),
      ...(signature ? { txSignature: signature } : {}),
      ...(combinedNotes.length > 0 ? { notes: combinedNotes } : {}),
    };

    return {
      position,
      ...(signature ? { signature } : {}),
      dryRun,
      liquidityAdded: addError === undefined,
      ...(addError ? { error: addError } : {}),
    };
  }

  private async assertWalletCanFundLiquidity(
    owner: PublicKey,
    pool: Pool,
    totalXAmount: BN,
    totalYAmount: BN,
  ): Promise<void> {
    const checks = [
      { side: "X", token: pool.tokenX, required: totalXAmount },
      { side: "Y", token: pool.tokenY, required: totalYAmount },
    ].filter((item) => item.required.gt(new BN(0)));

    const shortages: string[] = [];
    for (const check of checks) {
      const balance = await this.getWalletTokenBalanceRaw(
        owner,
        check.token.mint,
      );
      if (balance.lt(check.required)) {
        shortages.push(
          `${check.side}:${check.token.symbol} required=${check.required.toString()} available=${balance.toString()}`,
        );
      }
    }

    if (shortages.length > 0) {
      throw new Error(
        `openPosition: insufficient wallet token balance before add-liquidity for ${pool.name}. ` +
          `Missing ${shortages.join(", ")}. ` +
          "Fund both DLMM sides first; for SOL quote pools this usually means buying the base token before opening.",
      );
    }
  }

  private async getWalletTokenBalanceRaw(
    owner: PublicKey,
    mint: string,
  ): Promise<BN> {
    if (mint === SOL_MINT) {
      const lamports = await this.connection.getBalance(owner, "confirmed");
      return new BN(lamports.toString());
    }

    const resp = await this.connection.getParsedTokenAccountsByOwner(
      owner,
      { mint: new PublicKey(mint) },
      "confirmed",
    );
    let total = new BN(0);
    for (const acc of resp.value) {
      const parsed = acc.account.data as {
        parsed?: { info?: { tokenAmount?: { amount?: string } } };
      };
      const amount = parsed.parsed?.info?.tokenAmount?.amount;
      if (amount && /^\d+$/.test(amount)) {
        total = total.add(new BN(amount));
      }
    }
    return total;
  }

  // ---------- closeEmptyPosition ----------
  /**
   * Close an EMPTY position (no liquidity) using the DLMM SDK's
   * `closePositionIfEmpty` instruction. Used by the cleanup runner to reclaim
   * rent from phantom positions left over when `createEmptyPosition` succeeded
   * but `addLiquidityByStrategy` failed (e.g. wallet missing tokens).
   *
   * The caller MUST supply the pool address (we have it on tracker.Position),
   * which avoids the extra on-chain account-info round-trip that
   * `fetchPositionState` performs.
   */
  async closeEmptyPosition(args: {
    positionPubkey: string;
    poolAddress: string;
    dryRun?: boolean;
  }): Promise<CloseEmptyPositionResult> {
    const dryRun = args.dryRun === true;
    const positionPk = new PublicKey(args.positionPubkey);
    const poolPk = new PublicKey(args.poolAddress);

    const { instance: dlmm } = await getDlmmInstance(this.connection, poolPk);

    if (typeof dlmm.closePositionIfEmpty !== "function") {
      throw new Error(
        "closeEmptyPosition failed: DLMM SDK does not expose closePositionIfEmpty",
      );
    }

    const owner = this.wallet.isConfigured()
      ? this.wallet.getPublicKey()
      : Keypair.generate().publicKey;

    this.requireWallet("closeEmptyPosition", dryRun);

    // SDK reads `publicKey` and bin metadata off of the LbPosition object
    // returned by `getPosition`. Re-fetching keeps `closePositionIfEmpty`
    // happy without us hand-rolling the LbPosition shape.
    const lbPosition = await dlmm.getPosition(positionPk);
    const tx = await dlmm.closePositionIfEmpty({ owner, position: lbPosition });

    log.info(
      { position: args.positionPubkey, pool: args.poolAddress, dryRun },
      "closing empty position",
    );

    const signature = await sendTxs(this.wallet, tx, { dryRun });

    return {
      ...(signature ? { signature } : {}),
      dryRun,
      reclaimedSolEstimate: 0.057,
    };
  }

  // ---------- closePosition ----------
  async closePosition(args: {
    positionPubkey: string;
    poolAddress?: string;
    dryRun?: boolean;
  }): Promise<CloseResult> {
    const dryRun = args.dryRun === true;
    const positionPk = new PublicKey(args.positionPubkey);

    const state = await this.fetchPositionState(
      args.positionPubkey,
      args.poolAddress,
    );
    if (!state) {
      throw new Error(
        `closePosition: cannot resolve on-chain state for ${args.positionPubkey}`,
      );
    }

    const poolPk = new PublicKey(state.poolAddress);
    const { instance: dlmm } = await getDlmmInstance(this.connection, poolPk);

    const user = this.wallet.isConfigured()
      ? this.wallet.getPublicKey()
      : Keypair.generate().publicKey;

    this.requireWallet("closePosition", dryRun);

    const claimSignatures: string[] = [];
    try {
      const positionForClaim = await dlmm.getPosition(positionPk);
      const claimTxs = await dlmm.claimSwapFee({
        owner: user,
        position: positionForClaim,
      });
      const txCount = Array.isArray(claimTxs) ? claimTxs.length : 1;
      if (txCount > 0) {
        log.info(
          { position: args.positionPubkey, txCount, dryRun },
          "closePosition: claiming fees before close",
        );
        claimSignatures.push(
          ...(await sendTxList(this.wallet, claimTxs, { dryRun })),
        );
      }
    } catch (err) {
      log.warn(
        {
          position: args.positionPubkey,
          err: err instanceof Error ? err.message : String(err),
        },
        "closePosition: fee claim skipped or failed before close",
      );
    }

    const positionForClose = await dlmm.getPosition(positionPk);
    const data = positionForClose.positionData ?? {};
    const bins = data.positionBinData ?? [];
    const sortedBinIds = bins
      .map((b) => b.binId)
      .filter((b) => typeof b === "number")
      .sort((a, b) => a - b);
    const fromBinId =
      typeof data.lowerBinId === "number"
        ? data.lowerBinId
        : (sortedBinIds[0] ?? state.lowerBinId);
    const toBinId =
      typeof data.upperBinId === "number"
        ? data.upperBinId
        : (sortedBinIds[sortedBinIds.length - 1] ?? state.upperBinId);
    const hasLiquidity = bins.some((bin) =>
      new BN(toBnString(bin.positionLiquidity)).gt(new BN(0)),
    );

    let closeTxs: Transaction | Transaction[];
    if (hasLiquidity) {
      closeTxs = await dlmm.removeLiquidity({
        position: positionPk,
        user,
        fromBinId,
        toBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true,
      });
    } else if (typeof dlmm.closePositionIfEmpty === "function") {
      log.warn(
        { position: args.positionPubkey, pool: state.poolAddress },
        "closePosition: no liquidity detected; closing empty account",
      );
      closeTxs = await dlmm.closePositionIfEmpty({
        owner: user,
        position: positionForClose,
      });
    } else if (typeof dlmm.closePosition === "function") {
      log.warn(
        { position: args.positionPubkey, pool: state.poolAddress },
        "closePosition: no liquidity detected; closing account",
      );
      closeTxs = await dlmm.closePosition({
        owner: user,
        position: positionForClose,
      });
    } else {
      throw new Error(
        "closePosition: DLMM SDK does not expose a close-empty-position method",
      );
    }

    log.info(
      {
        position: args.positionPubkey,
        fromBinId,
        toBinId,
        hasLiquidity,
        dryRun,
      },
      "closing position",
    );

    const closeSignatures = await sendTxList(this.wallet, closeTxs, { dryRun });
    const signature =
      closeSignatures[closeSignatures.length - 1] ??
      claimSignatures[claimSignatures.length - 1];

    // Fix 2B: post-close RPC verification — confirm PDA is actually gone on-chain.
    // Under dryRun no tx was sent so skip the check.
    if (!dryRun) {
      if (!signature) {
        log.error(
          { position: args.positionPubkey },
          "closePosition: no tx signature returned — close was not submitted",
        );
        throw new Error(
          `closePosition: no tx signature returned for ${args.positionPubkey}; close was not submitted`,
        );
      } else {
        // Match Meridian's close flow: wait briefly for RPC to reflect the
        // account closure, then retry a few times before declaring failure.
        await new Promise<void>((r) => setTimeout(r, 5_000));
        const MAX_ATTEMPTS = 4;
        const DELAY_MS = 3_000;
        let accountInfo = await this.connection.getAccountInfo(positionPk);
        for (
          let attempt = 1;
          accountInfo !== null && attempt < MAX_ATTEMPTS;
          attempt++
        ) {
          log.debug(
            { position: args.positionPubkey, attempt },
            `closePosition: account still present after attempt ${attempt}, retrying in ${DELAY_MS} ms…`,
          );
          await new Promise<void>((r) => setTimeout(r, DELAY_MS));
          accountInfo = await this.connection.getAccountInfo(positionPk);
        }
        if (accountInfo !== null) {
          log.error(
            { position: args.positionPubkey, signature },
            "closePosition: RPC verification FAILED — position account still exists after close tx",
          );
          throw new Error(
            `closePosition: post-close verification failed — position PDA ${args.positionPubkey} still exists on-chain after tx ${signature}`,
          );
        }
        log.info(
          { position: args.positionPubkey, signature },
          "closePosition: RPC verification passed — position account confirmed closed",
        );
      }
    } else {
      log.debug(
        { position: args.positionPubkey },
        "closePosition: dryRun=true — skipping post-close RPC verification",
      );
    }

    return {
      ...(signature ? { signature } : {}),
      ...(claimSignatures.length > 0 ? { claimSignatures } : {}),
      ...(closeSignatures.length > 0 ? { closeSignatures } : {}),
      receivedX: state.amountX,
      receivedY: state.amountY,
      claimedFeeX: state.claimableFeeX,
      claimedFeeY: state.claimableFeeY,
      dryRun,
    };
  }

  // ---------- claimFees ----------
  async claimFees(args: {
    positionPubkey: string;
    poolAddress?: string;
    dryRun?: boolean;
  }): Promise<ClaimResult> {
    const dryRun = args.dryRun === true;
    const positionPk = new PublicKey(args.positionPubkey);

    const state = await this.fetchPositionState(
      args.positionPubkey,
      args.poolAddress,
    );
    if (!state) {
      throw new Error(
        `claimFees: cannot resolve on-chain state for ${args.positionPubkey}`,
      );
    }

    const poolPk = new PublicKey(state.poolAddress);
    const { instance: dlmm } = await getDlmmInstance(this.connection, poolPk);

    const owner = this.wallet.isConfigured()
      ? this.wallet.getPublicKey()
      : Keypair.generate().publicKey;

    let tx: Transaction | Transaction[];
    try {
      const lbPosition = await dlmm.getPosition(positionPk);
      tx = await dlmm.claimSwapFee({ owner, position: lbPosition });
    } catch (err) {
      if (typeof dlmm.claimAllSwapFee === "function") {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "claimSwapFee failed; falling back to claimAllSwapFee",
        );
        const lbPosition = await dlmm.getPosition(positionPk);
        tx = await dlmm.claimAllSwapFee({
          owner,
          positions: [lbPosition],
        });
      } else {
        throw err;
      }
    }

    log.info({ position: args.positionPubkey, dryRun }, "claiming fees");

    this.requireWallet("claimFees", dryRun);
    const signature = await sendTxs(this.wallet, tx, { dryRun });

    return {
      ...(signature ? { signature } : {}),
      claimedX: state.claimableFeeX,
      claimedY: state.claimableFeeY,
      dryRun,
    };
  }

  // ---------- rebalance ----------
  async rebalance(args: {
    positionPubkey: string;
    newRangeBps: number;
    dryRun?: boolean;
  }): Promise<RebalanceResult> {
    if (args.newRangeBps <= 0) {
      throw new Error("rebalance: newRangeBps must be > 0");
    }
    const dryRun = args.dryRun === true;

    const state = await this.fetchPositionState(args.positionPubkey);
    if (!state) {
      throw new Error(
        `rebalance: cannot resolve on-chain state for ${args.positionPubkey}`,
      );
    }

    const pool = await this.meteora.fetchPairByAddress(state.poolAddress);
    if (!pool) {
      throw new Error(
        `rebalance: pool not found via Meteora API: ${state.poolAddress}`,
      );
    }

    const poolPk = new PublicKey(state.poolAddress);
    const { instance: dlmm, mod } = await getDlmmInstance(this.connection, poolPk);

    this.requireWallet("rebalance", dryRun);

    const user = this.wallet.getPublicKey();

    log.info(
      {
        position: args.positionPubkey,
        pool: pool.name,
        dryRun,
      },
      "rebalance: using SDK atomic rebalance",
    );

    // ── 1. Fetch on-chain position data ──
    const positionData = await dlmm.getPosition(new PublicKey(args.positionPubkey));

    // SDK's processPosition() returns null when bin arrays are missing on-chain,
    // which makes positionBinData undefined and causes a crash in RebalancePosition.
    const innerData = positionData?.positionData;
    const binData = innerData?.positionBinData;
    if (!binData || !Array.isArray(binData) || binData.length === 0) {
      throw new Error(
        `rebalance: position ${args.positionPubkey} has no bin data on-chain (bin arrays may have been garbage-collected). Close and re-open the position instead.`,
      );
    }

    if (!dlmm.simulateRebalancePositionWithBalancedStrategy || !dlmm.rebalancePosition) {
      throw new Error(
        "rebalance: SDK does not expose simulateRebalancePositionWithBalancedStrategy/rebalancePosition. Upgrade @meteora-ag/dlmm.",
      );
    }

    // ── 2. Simulate rebalance with Spot strategy ──
    // topUpAmount = 0 (no extra capital), withdrawBps = 10000 (100% withdraw)
    // SDK types say PositionShape but runtime toRebalancePositionBinData()
    // accesses positionData.positionBinData directly — needs the inner object.
    const strategyType = resolveStrategyType(mod, "Spot");
    const simulationResult = await dlmm.simulateRebalancePositionWithBalancedStrategy(
      new PublicKey(args.positionPubkey),
      innerData as unknown as PositionShape,
      strategyType as 0 | 1 | 2,
      new BN(0), // topUpAmountX: no extra deposit
      new BN(0), // topUpAmountY: no extra deposit
      new BN(10_000), // xWithdrawBps: withdraw 100% of X
      new BN(10_000), // yWithdrawBps: withdraw 100% of Y
    );

    log.info(
      { position: args.positionPubkey },
      "rebalance: simulation complete",
    );

    // ── 3. Pre-create ATAs if missing (SDK CU estimation sim doesn't include preInstructions) ──
    const tokenX = dlmm.tokenX as { publicKey: PublicKey; owner: PublicKey };
    const tokenY = dlmm.tokenY as { publicKey: PublicKey; owner: PublicKey };
    const tokenProgramX = tokenX.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const tokenProgramY = tokenY.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const ataIxX = createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(tokenX.publicKey, user, true, tokenProgramX), user, tokenX.publicKey, tokenProgramX);
    const ataIxY = createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(tokenY.publicKey, user, true, tokenProgramY), user, tokenY.publicKey, tokenProgramY);
    const ataTx = new Transaction().add(ataIxX, ataIxY);
    await sendTxList(this.wallet, ataTx, { dryRun });

    // ── 4. Build rebalance transaction ──
    const rebalanceResult = await dlmm.rebalancePosition(
      simulationResult,
      new BN(10) as unknown as number, // maxActiveBinSlippage (TS says number, runtime wants BN)
      user, // rentPayer
      100, // slippage
    );

    // SDK returns { initBinArrayInstructions, rebalancePositionInstruction } as
    // TransactionInstruction[][] — wrap each into a Transaction.
    const raw = rebalanceResult as unknown as {
      initBinArrayInstructions?: TransactionInstruction[];
      rebalancePositionInstruction?: TransactionInstruction[];
    };
    const ixs: Transaction[] = [];
    if (raw.initBinArrayInstructions?.length) {
      const tx = new Transaction();
      tx.add(...raw.initBinArrayInstructions);
      ixs.push(tx);
    }
    if (raw.rebalancePositionInstruction?.length) {
      const tx = new Transaction();
      tx.add(...raw.rebalancePositionInstruction);
      ixs.push(tx);
    }

    if (dryRun) {
      log.info(
        { position: args.positionPubkey },
        "rebalance: dry-run, transaction not sent",
      );
      return {
        newPosition: {
          positionPubkey: args.positionPubkey,
          poolAddress: state.poolAddress,
          poolName: pool.name,
          tokenX: pool.tokenX,
          tokenY: pool.tokenY,
          binStep: pool.binStep,
          lowerBinId: positionData.positionData?.lowerBinId ?? state.lowerBinId,
          upperBinId: positionData.positionData?.upperBinId ?? state.upperBinId,
          entryValueUsd: 0,
          entryActiveBinId: pool.activeBinId,
          entryPrice: pool.currentPrice,
          entryAmountX: state.amountX,
          entryAmountY: state.amountY,
          entryTimestamp: Date.now(),
          strategyType: "Spot" as const,
          dryRun: true,
        },
        dryRun: true,
      };
    }

    // ── 4. Send rebalance transaction ──
    if (ixs.length === 0) {
      throw new Error("rebalance: SDK returned no instructions");
    }

    const sigs = await sendTxList(this.wallet, ixs, { dryRun: false });
    const sig = sigs[sigs.length - 1];

    log.info(
      {
        position: args.positionPubkey,
        signature: sig,
      },
      "rebalance: transaction sent",
    );

    return {
      ...(sig ? { openSig: sig } : {}),
      newPosition: {
        positionPubkey: args.positionPubkey,
        poolAddress: state.poolAddress,
        poolName: pool.name,
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        binStep: pool.binStep,
        lowerBinId: positionData.positionData?.lowerBinId ?? state.lowerBinId,
        upperBinId: positionData.positionData?.upperBinId ?? state.upperBinId,
        entryValueUsd: 0,
        entryActiveBinId: pool.activeBinId,
        entryPrice: pool.currentPrice,
        entryAmountX: state.amountX,
        entryAmountY: state.amountY,
        entryTimestamp: Date.now(),
        strategyType: "Spot" as const,
        dryRun,
      },
      dryRun,
    };
  }

  // ---------- fetchPositionState ----------
  async positionAccountExists(positionPubkey: string): Promise<boolean> {
    const positionPk = new PublicKey(positionPubkey);
    const accountInfo = await this.connection.getAccountInfo(
      positionPk,
      "confirmed",
    );
    return accountInfo !== null;
  }

  async fetchPositionState(
    positionPubkey: string,
    poolAddress?: string,
  ): Promise<PositionOnChainState | null> {
    try {
      const positionPk = new PublicKey(positionPubkey);
      const resolvedPool = await this.resolvePoolForPosition(
        positionPk,
        poolAddress,
      );
      if (!resolvedPool) {
        return null;
      }
      const poolPk = new PublicKey(resolvedPool);

      const { instance: dlmm } = await getDlmmInstance(this.connection, poolPk);

      let active: ActiveBinShape | null = null;
      try {
        active = await dlmm.getActiveBin();
      } catch {
        active = null;
      }

      const posInfo = await dlmm.getPosition(positionPk);
      const data = posInfo.positionData ?? {};
      const binData = data.positionBinData ?? [];

      const sortedBinIds = binData
        .map((b) => b.binId)
        .filter((b) => typeof b === "number")
        .sort((a, b) => a - b);

      const lower =
        typeof data.lowerBinId === "number"
          ? data.lowerBinId
          : (sortedBinIds[0] ?? 0);
      const upper =
        typeof data.upperBinId === "number"
          ? data.upperBinId
          : (sortedBinIds[sortedBinIds.length - 1] ?? 0);

      return {
        positionPubkey,
        poolAddress: poolPk.toBase58(),
        amountX: toBnString(data.totalXAmount),
        amountY: toBnString(data.totalYAmount),
        activeBinId: typeof active?.binId === "number" ? active.binId : 0,
        lowerBinId: lower,
        upperBinId: upper,
        claimableFeeX: toBnString(data.feeX),
        claimableFeeY: toBnString(data.feeY),
      };
    } catch (err) {
      log.warn(
        {
          position: positionPubkey,
          err: err instanceof Error ? err.message : String(err),
        },
        "fetchPositionState failed",
      );
      return null;
    }
  }

  private async resolvePoolForPosition(
    positionPk: PublicKey,
    poolAddress?: string,
  ): Promise<string | null> {
    if (poolAddress && poolAddress.trim().length > 0) {
      return new PublicKey(poolAddress).toBase58();
    }

    if (this.wallet.isConfigured()) {
      try {
        const mod = await loadDlmmModule();
        const dlmmStatic = resolveDlmmStatic(mod);
        if (dlmmStatic?.getAllLbPairPositionsByUser) {
          const allPositions = await dlmmStatic.getAllLbPairPositionsByUser(
            this.connection,
            this.wallet.getPublicKey(),
          );
          for (const [lbPairKey, info] of allPositions.entries()) {
            for (const pos of info.lbPairPositionsData ?? []) {
              if (pos.publicKey?.equals(positionPk)) return lbPairKey;
            }
          }
        }
      } catch (err) {
        log.warn(
          {
            position: positionPk.toBase58(),
            err: err instanceof Error ? err.message : String(err),
          },
          "resolvePoolForPosition: wallet position scan failed",
        );
      }
    }

    const accountInfo = await this.connection.getAccountInfo(
      positionPk,
      "confirmed",
    );
    if (!accountInfo || accountInfo.data.length < 8 + 32) {
      return null;
    }

    // Legacy fallback retained for old untracked callers. Current manager
    // paths pass the tracked pool address, which is the reliable SDK path.
    const lbPairBytes = accountInfo.data.subarray(8, 8 + 32);
    return new PublicKey(lbPairBytes).toBase58();
  }
}
