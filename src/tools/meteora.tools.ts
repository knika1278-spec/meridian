import axios, { AxiosInstance } from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { childLogger } from "../utils/logger.js";
import type {
  Pool,
  TokenInfo,
  TokenAuditInfo,
  HardFilters,
} from "../types/index.js";

const log = childLogger("meteora-tools");

// Meteora Pool Discovery API — exposes per-timeframe windowed metrics
// (volume/fee at the requested `timeframe`, e.g. "5m"). Distinct from the
// dlmm.datapi.meteora.ag detail API used by `fetchPairByAddress`.
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

const TIMEFRAME_MINUTES: Record<string, number> = {
  "5m": 5,
  "10m": 10,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "6h": 360,
  "12h": 720,
  "24h": 1440,
};

function timeframeToMinutes(tf: string): number {
  return TIMEFRAME_MINUTES[tf] ?? 1440;
}

// --- Zod schemas (defensive: accept extra fields and null/undefined) ---

const NumLike = z.union([z.number(), z.string(), z.null(), z.undefined()]);

const WindowedMetricSchema = z
  .object({
    "30m": NumLike.optional(),
    "1h": NumLike.optional(),
    "2h": NumLike.optional(),
    "4h": NumLike.optional(),
    "12h": NumLike.optional(),
    "24h": NumLike.optional(),
  })
  .passthrough();

const MeteoraTokenSchema = z
  .object({
    address: z.string(),
    name: z.string().optional().default(""),
    symbol: z.string().optional().default("UNK"),
    decimals: z.number().optional().default(9),
    is_verified: z.boolean().optional(),
    holders: NumLike,
    freeze_authority_disabled: z.boolean().optional(),
    total_supply: NumLike,
    price: NumLike,
    market_cap: NumLike,
  })
  .passthrough();

const PoolConfigSchema = z
  .object({
    bin_step: z.number().optional().default(0),
    base_fee_pct: NumLike,
    max_fee_pct: NumLike,
    protocol_fee_pct: NumLike,
    collect_fee_mode: z.number().optional(),
  })
  .passthrough();

const MeteoraPoolSchema = z
  .object({
    address: z.string(),
    name: z.string().optional().default(""),
    token_x: MeteoraTokenSchema,
    token_y: MeteoraTokenSchema,
    created_at: NumLike,
    pool_config: PoolConfigSchema,
    dynamic_fee_pct: NumLike,
    tvl: NumLike,
    current_price: NumLike,
    apr: NumLike,
    apy: NumLike,
    has_farm: z.boolean().optional(),
    farm_apr: NumLike,
    farm_apy: NumLike,
    volume: WindowedMetricSchema.optional(),
    fees: WindowedMetricSchema.optional(),
    protocol_fees: WindowedMetricSchema.optional(),
    fee_tvl_ratio: WindowedMetricSchema.optional(),
    cumulative_metrics: z
      .object({ volume: NumLike, fees: NumLike })
      .passthrough()
      .optional(),
    is_blacklisted: z.boolean().optional(),
    launchpad: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

type MeteoraPool = z.infer<typeof MeteoraPoolSchema>;

const PoolsPageSchema = z
  .object({
    total: z.number().optional(),
    pages: z.number().optional(),
    current_page: z.number().optional(),
    page_size: z.number().optional(),
    data: z.array(MeteoraPoolSchema),
  })
  .passthrough();

// --- Pool Discovery API schemas (windowed per `timeframe`) ---

const DiscoveryTokenSchema = z
  .object({
    address: z.string(),
    name: z.string().optional().default(""),
    symbol: z.string().optional().default("UNK"),
    decimals: z.number().optional().default(9),
    is_verified: z.boolean().optional(),
    holders: NumLike,
    has_freeze_authority: z.boolean().optional(),
    has_mint_authority: z.boolean().optional(),
    total_supply: NumLike,
    price: NumLike,
    market_cap: NumLike,
    fdv: NumLike,
    organic_score: NumLike,
    top_holders_pct: NumLike,
    tags: z.array(z.string()).optional(),
    warnings: z
      .array(z.object({ type: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

const DiscoveryDlmmParamsSchema = z
  .object({ bin_step: z.number().optional().default(0) })
  .passthrough();

const DiscoveryPoolSchema = z
  .object({
    pool_address: z.string(),
    name: z.string().optional().default(""),
    token_x: DiscoveryTokenSchema,
    token_y: DiscoveryTokenSchema,
    pool_type: z.string().optional(),
    fee_pct: NumLike,
    pool_created_at: NumLike,
    is_blacklisted: z.boolean().optional(),
    dlmm_params: DiscoveryDlmmParamsSchema.nullable().optional(),
    tvl: NumLike,
    active_tvl: NumLike,
    volume: NumLike,
    fee: NumLike,
    pool_price: NumLike,
    volatility: NumLike,
  })
  .passthrough();

const DiscoveryPoolsPageSchema = z
  .object({
    total: z.number().optional(),
    page_size: z.number().optional(),
    has_more: z.boolean().optional(),
    after_key: z.string().nullable().optional(),
    data: z.array(DiscoveryPoolSchema),
  })
  .passthrough();

// --- Helpers ---

function toNumberSafe(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctToBps(value: unknown): number {
  // Meteora returns *percentages* like 0.04 (= 0.04%) → 4 bps.
  // bps = pct * 100.
  const pct = toNumberSafe(value, 0);
  return Math.round(pct * 100);
}

function mapToken(raw: z.infer<typeof MeteoraTokenSchema>): TokenInfo {
  const out: TokenInfo = {
    mint: raw.address,
    symbol: raw.symbol || "UNK",
    decimals: typeof raw.decimals === "number" ? raw.decimals : 9,
  };
  if (raw.name) out.name = raw.name;
  const holders = toNumberSafe(raw.holders, NaN);
  if (Number.isFinite(holders)) out.holders = holders;
  const marketCap = toNumberSafe(raw.market_cap, NaN);
  if (Number.isFinite(marketCap)) out.marketCap = marketCap;
  const price = toNumberSafe(raw.price, NaN);
  if (Number.isFinite(price)) out.priceUsd = price;
  return out;
}

function mapPool(raw: MeteoraPool): Pool {
  const tvl = toNumberSafe(raw.tvl, 0);
  const volume24h = toNumberSafe(raw.volume?.["24h"], 0);
  const fees24h = toNumberSafe(raw.fees?.["24h"], 0);
  const currentPrice = toNumberSafe(raw.current_price, 0);

  const tokenX = mapToken(raw.token_x);
  const tokenY = mapToken(raw.token_y);

  // dlmm.datapi exposes the 24h fee/TVL ratio and `apr` already in PERCENT
  // form (e.g. 5.96 = 5.96%/day), so annualize with ×365 only — multiplying by
  // 100 again would inflate APR ~100x. feeApr is derived from the fee/TVL
  // fraction (×100 to percent) to stay consistent with the screener path.
  const apr = toNumberSafe(raw.apr, 0); // daily fee/TVL ratio, percent form
  const feeTvlFrac = tvl > 0 ? fees24h / tvl : 0;
  const feeApr24h = feeTvlFrac > 0 ? feeTvlFrac * 365 * 100 : undefined;
  const totalApr24h = apr > 0 ? apr * 365 : undefined;

  const pool: Pool = {
    address: raw.address,
    name: raw.name || `${tokenX.symbol}-${tokenY.symbol}`,
    tokenX,
    tokenY,
    binStep: raw.pool_config.bin_step ?? 0,
    baseFeeBps: pctToBps(raw.pool_config.base_fee_pct),
    protocolFeeBps: pctToBps(raw.pool_config.protocol_fee_pct),
    tvl,
    activeTvl: tvl, // refined by enrichOnChain when available
    volume24h,
    fees24h,
    activeBinId: 0,
    currentPrice,
    feeApr24h,
    feeAprActive24h: undefined,
    totalApr24h,
    createdAt:
      toNumberSafe(raw.created_at, NaN) > 0
        ? toNumberSafe(raw.created_at)
        : undefined,
    raw,
  };

  return pool;
}

function mapDiscoveryToken(
  raw: z.infer<typeof DiscoveryTokenSchema>,
): TokenInfo {
  const out: TokenInfo = {
    mint: raw.address,
    symbol: raw.symbol || "UNK",
    decimals: typeof raw.decimals === "number" ? raw.decimals : 9,
  };
  if (raw.name) out.name = raw.name;
  const holders = toNumberSafe(raw.holders, NaN);
  if (Number.isFinite(holders)) out.holders = holders;
  const marketCap = toNumberSafe(raw.market_cap, NaN);
  if (Number.isFinite(marketCap)) out.marketCap = marketCap;
  const fdv = toNumberSafe(raw.fdv, NaN);
  if (Number.isFinite(fdv)) out.fdv = fdv;
  const price = toNumberSafe(raw.price, NaN);
  if (Number.isFinite(price)) out.priceUsd = price;
  const organic = toNumberSafe(raw.organic_score, NaN);
  if (Number.isFinite(organic)) out.organicScore = organic;

  // Audit fallback straight from discovery fields; Jupiter enrichment in the
  // screener overrides this when available (mergeTokenInfo prefers `extra`).
  const audit: TokenAuditInfo = {
    flags: (raw.warnings ?? [])
      .map((w) => w.type)
      .filter((t): t is string => typeof t === "string"),
  };
  if (typeof raw.is_verified === "boolean") audit.isVerified = raw.is_verified;
  if (typeof raw.has_mint_authority === "boolean") {
    audit.mintAuthorityDisabled = !raw.has_mint_authority;
  }
  if (typeof raw.has_freeze_authority === "boolean") {
    audit.freezeAuthorityDisabled = !raw.has_freeze_authority;
  }
  const topHolders = toNumberSafe(raw.top_holders_pct, NaN);
  if (Number.isFinite(topHolders)) audit.topHoldersPct = topHolders;
  if (raw.tags && raw.tags.length > 0) audit.tags = raw.tags;
  out.audit = audit;

  return out;
}

function mapDiscoveryPool(
  raw: z.infer<typeof DiscoveryPoolSchema>,
  timeframeMinutes: number,
): Pool {
  const tvl = toNumberSafe(raw.tvl, 0);
  const activeTvlRaw = toNumberSafe(raw.active_tvl, 0);
  const activeTvl = activeTvlRaw > 0 ? activeTvlRaw : tvl;
  // `volume`/`fee` are totals for the requested timeframe window (e.g. 5m),
  // NOT 24h — they populate volume24h/fees24h to keep the Pool contract.
  const volume = toNumberSafe(raw.volume, 0);
  const fee = toNumberSafe(raw.fee, 0);
  const currentPrice = toNumberSafe(raw.pool_price, 0);

  const tokenX = mapDiscoveryToken(raw.token_x);
  const tokenY = mapDiscoveryToken(raw.token_y);

  // Annualize the windowed fee/TVL ratios so feeApr stays comparable across
  // timeframes (a 5m window repeats windowsPerYear times in a year). Derive
  // the ratio from fee/TVL directly (same basis as the hard filter). NOTE: do
  // NOT use the API's `fee_*_tvl_ratio` fields here — they are already
  // percentage-scaled (×100), so multiplying by 100 below would inflate the
  // APR ~100x.
  const windowsPerYear =
    timeframeMinutes > 0 ? (365 * 24 * 60) / timeframeMinutes : 0;
  const feeTvlRatio = tvl > 0 ? fee / tvl : 0;
  const feeActiveTvlRatio = activeTvl > 0 ? fee / activeTvl : 0;
  const feeApr24h =
    feeTvlRatio > 0 ? feeTvlRatio * windowsPerYear * 100 : undefined;
  const feeAprActive24h =
    feeActiveTvlRatio > 0
      ? feeActiveTvlRatio * windowsPerYear * 100
      : undefined;

  const pool: Pool = {
    address: raw.pool_address,
    name: raw.name || `${tokenX.symbol}-${tokenY.symbol}`,
    tokenX,
    tokenY,
    binStep: raw.dlmm_params?.bin_step ?? 0,
    baseFeeBps: pctToBps(raw.fee_pct),
    protocolFeeBps: 0,
    tvl,
    activeTvl,
    volume24h: volume,
    fees24h: fee,
    activeBinId: 0,
    currentPrice,
    feeApr24h,
    feeAprActive24h,
    totalApr24h: undefined,
    createdAt:
      toNumberSafe(raw.pool_created_at, NaN) > 0
        ? toNumberSafe(raw.pool_created_at)
        : undefined,
    raw,
  };

  return pool;
}

function buildDiscoveryFilter(filters?: HardFilters): string {
  const parts = ["pool_type=dlmm"];
  if (!filters) return parts.join("&&");

  parts.push(
    `base_token_market_cap>=${filters.marketCapMin}`,
    `base_token_market_cap<=${filters.marketCapMax}`,
    `base_token_holders>=${filters.holdersMin}`,
    `tvl>=${filters.tvlMin}`,
    `dlmm_bin_step>=${filters.binStepMin}`,
    `dlmm_bin_step<=${filters.binStepMax}`,
    `fee_active_tvl_ratio>=${filters.feeActiveTvlRatioMin}`,
    `base_token_organic_score>=${filters.organicScoreMin}`,
  );

  if (typeof filters.volume24hMin === "number") {
    parts.push(`volume>=${filters.volume24hMin}`);
  }
  if (typeof filters.tvlMax === "number") {
    parts.push(`tvl<=${filters.tvlMax}`);
  }

  return parts.join("&&");
}

// --- Public API ---

export interface MeteoraToolsOptions {
  apiUrl: string;
  programId: string;
  connection: Connection;
  /** Pool-discovery window for candidate metrics (e.g. "5m", "30m", "1h"). Default "5m". */
  timeframe?: string;
  /** Pool-discovery category (e.g. "trending"). Default "trending". */
  category?: string;
}

export type SortBy = "volume_24h" | "fees_24h" | "tvl";

const DLMM_INSTANCE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

interface DlmmCacheEntry {
  instance: unknown;
  expiresAt: number;
}

export class MeteoraTools {
  private readonly http: AxiosInstance;
  private readonly apiUrl: string;
  private readonly programId: string;
  private readonly connection: Connection;
  private readonly timeframe: string;
  private readonly category: string;
  private readonly dlmmInstanceCache = new Map<string, DlmmCacheEntry>();

  constructor(opts: MeteoraToolsOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.programId = opts.programId;
    this.connection = opts.connection;
    this.timeframe = opts.timeframe ?? "5m";
    this.category = opts.category ?? "trending";
    this.http = axios.create({
      baseURL: this.apiUrl,
      timeout: 15_000,
      headers: { Accept: "application/json" },
    });
  }

  async fetchAllPairs(opts?: {
    limit?: number;
    sortBy?: SortBy;
    filters?: HardFilters;
  }): Promise<Pool[]> {
    const limit = opts?.limit ?? 50;
    // Pool Discovery API returns metrics windowed to `timeframe`; ordering is
    // driven by `category` (e.g. "trending"), so `sortBy` is no longer used.
    // When filters are supplied, use Meridian-compatible Pool Discovery keys
    // to pre-filter candidates before local enrichment and hard-filter checks.
    const pageSize = Math.min(Math.max(1, limit), 100);
    const filterBy = encodeURIComponent(buildDiscoveryFilter(opts?.filters));
    const url =
      `${POOL_DISCOVERY_BASE}/pools?page_size=${pageSize}` +
      `&filter_by=${filterBy}` +
      `&timeframe=${encodeURIComponent(this.timeframe)}` +
      `&category=${encodeURIComponent(this.category)}`;

    try {
      const { data } = await axios.get(url, {
        timeout: 15_000,
        headers: { Accept: "application/json" },
      });
      const parsed = DiscoveryPoolsPageSchema.safeParse(data);
      if (!parsed.success) {
        log.error(
          { err: parsed.error.message },
          "failed to parse pool-discovery response",
        );
        throw new Error("Meteora pool-discovery: invalid schema");
      }
      const tfMinutes = timeframeToMinutes(this.timeframe);
      const pools = parsed.data.data.map((p) => mapDiscoveryPool(p, tfMinutes));
      return limit > 0 ? pools.slice(0, limit) : pools;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Meteora pool-discovery: ${msg}`);
    }
  }

  async fetchPairByAddress(address: string): Promise<Pool | null> {
    try {
      const { data } = await this.http.get(`/pools/${address}`);
      const parsed = MeteoraPoolSchema.safeParse(data);
      if (!parsed.success) {
        log.warn(
          { address, err: parsed.error.message },
          "pool schema mismatch",
        );
        return null;
      }
      return mapPool(parsed.data);
    } catch (err) {
      const anyErr = err as {
        response?: { status?: number };
        message?: string;
      };
      if (anyErr.response?.status === 404) {
        return null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Meteora API: ${msg}`);
    }
  }

  /**
   * Best-effort on-chain enrichment via @meteora-ag/dlmm SDK.
   * Returns partial fields; never throws.
   */
  async enrichOnChain(address: string): Promise<Partial<Pool>> {
    try {
      const { loadDlmmSdk } = await import("./dlmm-loader.js");
      const mod: unknown = loadDlmmSdk();
      const DLMMCtor = resolveDlmmFactory(mod);
      if (!DLMMCtor) {
        log.warn(
          { address },
          "DLMM SDK factory not found; skipping on-chain enrichment",
        );
        return {};
      }

      const pubkey = new PublicKey(address);
      const now = Date.now();
      const cached = this.dlmmInstanceCache.get(address);
      const instance =
        cached && cached.expiresAt > now
          ? cached.instance
          : await (async () => {
              const fresh = await DLMMCtor(this.connection, pubkey);
              this.dlmmInstanceCache.set(address, {
                instance: fresh,
                expiresAt: now + DLMM_INSTANCE_TTL_MS,
              });
              return fresh;
            })();

      const out: Partial<Pool> = {};

      const activeBin = await tryGetActiveBin(instance);
      if (activeBin && typeof activeBin.binId === "number") {
        out.activeBinId = activeBin.binId;
        if (
          typeof activeBin.price === "number" &&
          Number.isFinite(activeBin.price)
        ) {
          out.currentPrice = activeBin.price;
        } else if (typeof activeBin.price === "string") {
          const n = Number(activeBin.price);
          if (Number.isFinite(n)) out.currentPrice = n;
        }
      }

      return out;
    } catch (err) {
      log.warn(
        { address, err: err instanceof Error ? err.message : String(err) },
        "on-chain enrichment failed",
      );
      return {};
    }
  }

  getProgramId(): string {
    return this.programId;
  }
}

// --- SDK shim helpers (defensive, no `any`) ---

type DlmmFactory = (
  connection: Connection,
  pubkey: PublicKey,
) => Promise<unknown>;

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

interface ActiveBinShape {
  binId?: number;
  price?: number | string;
}

async function tryGetActiveBin(
  instance: unknown,
): Promise<ActiveBinShape | null> {
  if (!instance || typeof instance !== "object") return null;
  const obj = instance as Record<string, unknown>;
  const fn = obj.getActiveBin;
  if (typeof fn !== "function") return null;
  try {
    const res = await (fn as () => Promise<unknown>).call(instance);
    if (res && typeof res === "object") {
      return res as ActiveBinShape;
    }
    return null;
  } catch {
    return null;
  }
}
