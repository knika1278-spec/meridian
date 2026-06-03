import axios, { AxiosInstance } from "axios";
import { z } from "zod";
import { childLogger } from "../utils/logger.js";

const log = childLogger("meteora-pnl-tools");

const NumLike = z.union([z.number(), z.string(), z.null(), z.undefined()]);

// Meteora's PnL API returns slightly different field names across endpoints;
// accept both snake_case and camelCase.
const MeteoraPnlRawSchema = z
  .object({
    position_address: z.string().optional(),
    positionAddress: z.string().optional(),
    pool_address: z.string().optional(),
    poolAddress: z.string().optional(),
    owner: z.string().optional(),
    total_fee_x_claimed: NumLike,
    total_fee_y_claimed: NumLike,
    total_fee_usd_claimed: NumLike,
    totalFeeUsdClaimed: NumLike,
    unclaimed_fee_usd: NumLike,
    unclaimedFeeUsd: NumLike,
    total_pnl_usd: NumLike,
    totalPnlUsd: NumLike,
    realized_pnl_usd: NumLike,
    realizedPnlUsd: NumLike,
    fee_apr_24h: NumLike,
    feeApr24h: NumLike,
    impermanent_loss_usd: NumLike,
    impermanentLossUsd: NumLike,
    deposits_usd: NumLike,
    withdrawals_usd: NumLike,
    last_updated_at: NumLike,
  })
  .passthrough();

const WalletPositionsResponseSchema = z
  .object({
    positions: z.array(MeteoraPnlRawSchema).optional(),
    data: z.array(MeteoraPnlRawSchema).optional(),
  })
  .passthrough();

export interface MeteoraPositionPnl {
  positionAddress?: string;
  poolAddress?: string;
  owner?: string;
  totalFeeUsdClaimed: number;
  unclaimedFeeUsd: number;
  totalPnlUsd: number;
  realizedPnlUsd?: number;
  impermanentLossUsd: number;
  feeApr24h?: number;
  depositsUsd?: number;
  withdrawalsUsd?: number;
  lastUpdatedAt?: number;
}

export interface MeteoraPnlToolsOptions {
  /**
   * Base URL for Meteora's PnL API.
   * Default in practice: https://dlmm-api.meteora.ag
   */
  baseUrl: string;
  cacheTtlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function toNumberSafe(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickNum(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (c === null || c === undefined || c === "") continue;
    const n = typeof c === "number" ? c : Number(c);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function mapPnl(raw: z.infer<typeof MeteoraPnlRawSchema>): MeteoraPositionPnl {
  const out: MeteoraPositionPnl = {
    totalFeeUsdClaimed: toNumberSafe(
      raw.total_fee_usd_claimed ?? raw.totalFeeUsdClaimed,
    ),
    unclaimedFeeUsd: toNumberSafe(raw.unclaimed_fee_usd ?? raw.unclaimedFeeUsd),
    totalPnlUsd: toNumberSafe(raw.total_pnl_usd ?? raw.totalPnlUsd),
    impermanentLossUsd: toNumberSafe(
      raw.impermanent_loss_usd ?? raw.impermanentLossUsd,
    ),
  };
  const addr = raw.position_address ?? raw.positionAddress;
  if (addr) out.positionAddress = addr;
  const pool = raw.pool_address ?? raw.poolAddress;
  if (pool) out.poolAddress = pool;
  if (raw.owner) out.owner = raw.owner;
  const realized = pickNum(raw.realized_pnl_usd, raw.realizedPnlUsd);
  if (realized !== undefined) out.realizedPnlUsd = realized;
  const apr = pickNum(raw.fee_apr_24h, raw.feeApr24h);
  if (apr !== undefined) out.feeApr24h = apr;
  const dep = pickNum(raw.deposits_usd);
  if (dep !== undefined) out.depositsUsd = dep;
  const wd = pickNum(raw.withdrawals_usd);
  if (wd !== undefined) out.withdrawalsUsd = wd;
  const ts = pickNum(raw.last_updated_at);
  if (ts !== undefined) out.lastUpdatedAt = ts;
  return out;
}

/**
 * Meteora DLMM PnL API wrapper.
 *
 * The official PnL feed exposes per-position fee accrual and PnL straight
 * from Meteora's indexer. Used by the Manager to cross-check the locally
 * computed PnL/fee numbers from on-chain state.
 *
 * All methods are best-effort: any network or schema failure logs and
 * returns null/empty rather than throwing.
 */
export class MeteoraPnlTools {
  private readonly http: AxiosInstance;
  private readonly cacheTtlMs: number;
  private readonly positionCache = new Map<
    string,
    CacheEntry<MeteoraPositionPnl | null>
  >();

  constructor(opts: MeteoraPnlToolsOptions) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.http = axios.create({
      baseURL: opts.baseUrl.replace(/\/+$/, ""),
      timeout: 15_000,
      headers: { Accept: "application/json" },
    });
    log.info({ baseUrl: opts.baseUrl }, "meteora pnl tools initialized");
  }

  /**
   * Fetch official PnL for a single position. Returns null on 404 or any
   * other error (best-effort).
   */
  async getPositionPnl(
    positionAddress: string,
  ): Promise<MeteoraPositionPnl | null> {
    if (!positionAddress) return null;
    const cached = this.positionCache.get(positionAddress);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // Try a couple of well-known endpoint shapes — Meteora has used both
    // /position/{addr} and /pair/.../position/{addr} historically.
    const paths = [
      `/position/${positionAddress}/pnl`,
      `/position/${positionAddress}`,
    ];

    for (const p of paths) {
      try {
        const { data } = await this.http.get(p);
        const parsed = MeteoraPnlRawSchema.safeParse(data);
        if (parsed.success) {
          return this.cachePosition(positionAddress, mapPnl(parsed.data));
        }
        log.debug(
          { positionAddress, path: p, err: parsed.error.message },
          "pnl schema mismatch, trying next path",
        );
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response
          ?.status;
        if (status === 404) continue;
        log.debug(
          {
            positionAddress,
            path: p,
            err: err instanceof Error ? err.message : String(err),
          },
          "pnl request failed, trying next path",
        );
      }
    }
    return this.cachePosition(positionAddress, null);
  }

  /** All positions for a wallet. */
  async getWalletPositions(
    walletAddress: string,
  ): Promise<MeteoraPositionPnl[]> {
    if (!walletAddress) return [];
    try {
      const { data } = await this.http.get(
        `/wallet/${walletAddress}/positions`,
      );
      const parsed = WalletPositionsResponseSchema.safeParse(data);
      if (!parsed.success) {
        log.debug(
          { walletAddress, err: parsed.error.message },
          "wallet positions schema mismatch",
        );
        return [];
      }
      const arr = parsed.data.positions ?? parsed.data.data ?? [];
      return arr.map(mapPnl);
    } catch (err) {
      log.debug(
        {
          walletAddress,
          err: err instanceof Error ? err.message : String(err),
        },
        "wallet positions lookup failed",
      );
      return [];
    }
  }

  private cachePosition(
    key: string,
    value: MeteoraPositionPnl | null,
  ): MeteoraPositionPnl | null {
    this.positionCache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return value;
  }
}
