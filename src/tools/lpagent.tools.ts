import axios, { AxiosInstance } from "axios";
import { z } from "zod";
import { childLogger } from "../utils/logger.js";

const log = childLogger("lpagent-tools");

// ─── Response schemas ────────────────────────────────────────────────

const TimeframePnlSchema = z.object({
  ALL: z.number().default(0),
  "7D": z.number().default(0),
  "1M": z.number().default(0),
  "3M": z.number().default(0),
  "1Y": z.number().default(0),
  YTD: z.number().default(0),
});

const OverviewItemSchema = z
  .object({
    owner: z.string(),
    chain: z.string(),
    protocol: z.string(),
    total_inflow: z.number().default(0),
    total_outflow: z.number().default(0),
    total_fee: TimeframePnlSchema,
    total_fee_native: TimeframePnlSchema,
    total_pnl: TimeframePnlSchema,
    total_pnl_native: TimeframePnlSchema,
    total_reward: z.number().default(0),
    total_reward_native: z.number().default(0),
    win_rate: TimeframePnlSchema,
    win_rate_native: TimeframePnlSchema,
    opening_lp: z.number().default(0),
    total_lp: z.number().default(0),
    win_lp: z.number().default(0),
    win_lp_native: z.number().default(0),
    closed_lp: TimeframePnlSchema,
    apr: z.number().default(0),
    roi: z.number().default(0),
    roi_avg_inflow: z.number().default(0),
    roi_avg_inflow_native: z.number().default(0),
    avg_age_hour: z.number().default(0),
    total_pool: z.number().default(0),
    expected_value: TimeframePnlSchema,
    expected_value_native: TimeframePnlSchema,
    fee_percent: z.number().default(0),
    fee_percent_native: z.number().default(0),
    avg_pos_profit: z.number().default(0),
    avg_pos_profit_native: z.number().default(0),
    avg_monthly_profit_percent: z.number().default(0),
    avg_monthly_pnl: z.number().default(0),
    avg_monthly_inflow: z.number().default(0),
    avg_monthly_profit_percent_native: z.number().default(0),
    avg_monthly_pnl_native: z.number().default(0),
    avg_monthly_inflow_native: z.number().default(0),
    first_activity: z.string().nullable().optional(),
    last_activity: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    x_account: z.string().optional(),
    rev_share_model: z.string().optional(),
  })
  .passthrough();

const OpeningPositionSchema = z
  .object({
    position_address: z.string(),
    pool_address: z.string(),
    pool_name: z.string().optional(),
    token_x: z.string().optional(),
    token_y: z.string().optional(),
    token_x_symbol: z.string().optional(),
    token_y_symbol: z.string().optional(),
    bin_step: z.number().optional(),
    lower_bin: z.number().optional(),
    upper_bin: z.number().optional(),
    active_bin: z.number().optional(),
    in_range: z.boolean().optional(),
    deposit_amount: z.number().optional(),
    deposit_amount_native: z.number().optional(),
    current_value: z.number().optional(),
    current_value_native: z.number().optional(),
    fee_earned: z.number().optional(),
    fee_earned_native: z.number().optional(),
    pnl: z.number().optional(),
    pnl_native: z.number().optional(),
    pnl_percent: z.number().optional(),
    impermanent_loss: z.number().optional(),
    impermanent_loss_native: z.number().optional(),
    age_hour: z.number().optional(),
    apr: z.number().optional(),
    roi: z.number().optional(),
    opened_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const HistoryItemSchema = z
  .object({
    position_address: z.string(),
    pool_address: z.string(),
    pool_name: z.string().optional(),
    token_x_symbol: z.string().optional(),
    token_y_symbol: z.string().optional(),
    deposit_amount: z.number().optional(),
    deposit_amount_native: z.number().optional(),
    withdraw_amount: z.number().optional(),
    withdraw_amount_native: z.number().optional(),
    fee_earned: z.number().optional(),
    fee_earned_native: z.number().optional(),
    pnl: z.number().optional(),
    pnl_native: z.number().optional(),
    pnl_percent: z.number().optional(),
    impermanent_loss: z.number().optional(),
    impermanent_loss_native: z.number().optional(),
    age_hour: z.number().optional(),
    opened_at: z.string().optional(),
    closed_at: z.string().optional(),
    exit_reason: z.string().optional(),
  })
  .passthrough();

// ─── Public types ────────────────────────────────────────────────────

export interface LpAgentOverview {
  owner: string;
  totalPnlUsd: number;
  totalPnlSol: number;
  totalFeeUsd: number;
  totalFeeSol: number;
  totalRewardUsd: number;
  totalRewardSol: number;
  winRateUsd: number;
  winRateSol: number;
  openingPositions: number;
  totalPositions: number;
  winPositions: number;
  closedPositions: number;
  apr: number;
  roi: number;
  avgAgeHours: number;
  totalPools: number;
  expectedValueUsd: number;
  expectedValueSol: number;
  feePercentUsd: number;
  feePercentSol: number;
  avgPosProfitUsd: number;
  avgPosProfitSol: number;
  // Per-timeframe
  pnlByTimeframe: Record<string, number>;
  pnlByTimeframeNative: Record<string, number>;
  feeByTimeframe: Record<string, number>;
  feeByTimeframeNative: Record<string, number>;
  winRateByTimeframe: Record<string, number>;
  winRateByTimeframeNative: Record<string, number>;
  raw: z.infer<typeof OverviewItemSchema>;
}

export interface LpAgentOpeningPosition {
  positionAddress: string;
  poolAddress: string;
  poolName: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  binStep: number;
  lowerBin: number;
  upperBin: number;
  activeBin: number;
  inRange: boolean;
  depositUsd: number;
  depositSol: number;
  currentValueUsd: number;
  currentValueSol: number;
  feeEarnedUsd: number;
  feeEarnedSol: number;
  pnlUsd: number;
  pnlSol: number;
  pnlPercent: number;
  ilUsd: number;
  ilSol: number;
  ageHours: number;
  apr: number;
  roi: number;
  openedAt: string | null;
  updatedAt: string | null;
  raw: z.infer<typeof OpeningPositionSchema>;
}

export interface LpAgentHistoryItem {
  positionAddress: string;
  poolAddress: string;
  poolName: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  depositUsd: number;
  depositSol: number;
  withdrawUsd: number;
  withdrawSol: number;
  feeEarnedUsd: number;
  feeEarnedSol: number;
  pnlUsd: number;
  pnlSol: number;
  pnlPercent: number;
  ilUsd: number;
  ilSol: number;
  ageHours: number;
  openedAt: string | null;
  closedAt: string | null;
  exitReason: string;
  raw: z.infer<typeof HistoryItemSchema>;
}

export interface LpAgentToolsOptions {
  apiKey: string;
  baseUrl?: string;
  cacheTtlMs?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function toNum(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickTimeframe(obj: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = toNum(v);
  }
  return out;
}

function mapOverview(raw: z.infer<typeof OverviewItemSchema>): LpAgentOverview {
  return {
    owner: raw.owner,
    totalPnlUsd: toNum(raw.total_pnl?.ALL),
    totalPnlSol: toNum(raw.total_pnl_native?.ALL),
    totalFeeUsd: toNum(raw.total_fee?.ALL),
    totalFeeSol: toNum(raw.total_fee_native?.ALL),
    totalRewardUsd: toNum(raw.total_reward),
    totalRewardSol: toNum(raw.total_reward_native),
    winRateUsd: toNum(raw.win_rate?.ALL),
    winRateSol: toNum(raw.win_rate_native?.ALL),
    openingPositions: raw.opening_lp,
    totalPositions: raw.total_lp,
    winPositions: raw.win_lp,
    closedPositions: toNum(raw.closed_lp?.ALL),
    apr: raw.apr,
    roi: raw.roi,
    avgAgeHours: raw.avg_age_hour,
    totalPools: raw.total_pool,
    expectedValueUsd: toNum(raw.expected_value?.ALL),
    expectedValueSol: toNum(raw.expected_value_native?.ALL),
    feePercentUsd: raw.fee_percent,
    feePercentSol: raw.fee_percent_native,
    avgPosProfitUsd: raw.avg_pos_profit,
    avgPosProfitSol: raw.avg_pos_profit_native,
    pnlByTimeframe: pickTimeframe(raw.total_pnl ?? {}),
    pnlByTimeframeNative: pickTimeframe(raw.total_pnl_native ?? {}),
    feeByTimeframe: pickTimeframe(raw.total_fee ?? {}),
    feeByTimeframeNative: pickTimeframe(raw.total_fee_native ?? {}),
    winRateByTimeframe: pickTimeframe(raw.win_rate ?? {}),
    winRateByTimeframeNative: pickTimeframe(raw.win_rate_native ?? {}),
    raw,
  };
}

function mapOpening(
  raw: z.infer<typeof OpeningPositionSchema>,
): LpAgentOpeningPosition {
  return {
    positionAddress: raw.position_address,
    poolAddress: raw.pool_address,
    poolName: raw.pool_name ?? "",
    tokenXSymbol: raw.token_x_symbol ?? raw.token_x ?? "",
    tokenYSymbol: raw.token_y_symbol ?? raw.token_y ?? "",
    binStep: raw.bin_step ?? 0,
    lowerBin: raw.lower_bin ?? 0,
    upperBin: raw.upper_bin ?? 0,
    activeBin: raw.active_bin ?? 0,
    inRange: raw.in_range ?? false,
    depositUsd: toNum(raw.deposit_amount),
    depositSol: toNum(raw.deposit_amount_native),
    currentValueUsd: toNum(raw.current_value),
    currentValueSol: toNum(raw.current_value_native),
    feeEarnedUsd: toNum(raw.fee_earned),
    feeEarnedSol: toNum(raw.fee_earned_native),
    pnlUsd: toNum(raw.pnl),
    pnlSol: toNum(raw.pnl_native),
    pnlPercent: toNum(raw.pnl_percent),
    ilUsd: toNum(raw.impermanent_loss),
    ilSol: toNum(raw.impermanent_loss_native),
    ageHours: toNum(raw.age_hour),
    apr: toNum(raw.apr),
    roi: toNum(raw.roi),
    openedAt: raw.opened_at ?? null,
    updatedAt: raw.updated_at ?? null,
    raw,
  };
}

function mapHistory(
  raw: z.infer<typeof HistoryItemSchema>,
): LpAgentHistoryItem {
  return {
    positionAddress: raw.position_address,
    poolAddress: raw.pool_address,
    poolName: raw.pool_name ?? "",
    tokenXSymbol: raw.token_x_symbol ?? "",
    tokenYSymbol: raw.token_y_symbol ?? "",
    depositUsd: toNum(raw.deposit_amount),
    depositSol: toNum(raw.deposit_amount_native),
    withdrawUsd: toNum(raw.withdraw_amount),
    withdrawSol: toNum(raw.withdraw_amount_native),
    feeEarnedUsd: toNum(raw.fee_earned),
    feeEarnedSol: toNum(raw.fee_earned_native),
    pnlUsd: toNum(raw.pnl),
    pnlSol: toNum(raw.pnl_native),
    pnlPercent: toNum(raw.pnl_percent),
    ilUsd: toNum(raw.impermanent_loss),
    ilSol: toNum(raw.impermanent_loss_native),
    ageHours: toNum(raw.age_hour),
    openedAt: raw.opened_at ?? null,
    closedAt: raw.closed_at ?? null,
    exitReason: raw.exit_reason ?? "",
    raw,
  };
}

// ─── Main class ───────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * LPAgent API wrapper for Meteora DLMM position PnL tracking.
 *
 * Provides both USD and native SOL PnL figures, including fees,
 * impermanent loss, win rates, and per-position breakdowns.
 *
 * All methods are best-effort: network/schema failures log and
 * return null/empty rather than throwing.
 */
export class LpAgentTools {
  private readonly http: AxiosInstance;
  private readonly cacheTtlMs: number;
  private readonly overviewCache = new Map<
    string,
    CacheEntry<LpAgentOverview | null>
  >();
  private readonly openingCache = new Map<
    string,
    CacheEntry<LpAgentOpeningPosition[]>
  >();
  private readonly historyCache = new Map<
    string,
    CacheEntry<LpAgentHistoryItem[]>
  >();

  constructor(opts: LpAgentToolsOptions) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 10_000;
    this.http = axios.create({
      baseURL: (opts.baseUrl ?? "https://api.lpagent.io").replace(/\/+$/, ""),
      timeout: 15_000,
      headers: {
        Accept: "application/json",
        "x-api-key": opts.apiKey,
      },
    });
    log.info("lpagent tools initialized");
  }

  /**
   * Wallet-level PnL overview (USD + SOL).
   * Includes total PnL, fees, win rate, position counts, APR, ROI.
   */
  async getOverview(owner: string): Promise<LpAgentOverview | null> {
    if (!owner) return null;
    const cached = this.overviewCache.get(owner);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const { data } = await this.http.get(
        `/open-api/v1/lp-positions/overview`,
        { params: { owner } },
      );
      if (data.status !== "success" || !Array.isArray(data.data)) {
        log.warn({ owner, data }, "unexpected overview response shape");
        return this.cacheOverview(owner, null);
      }
      const first = data.data[0];
      if (!first) return this.cacheOverview(owner, null);
      const parsed = OverviewItemSchema.safeParse(first);
      if (!parsed.success) {
        log.warn(
          { owner, err: parsed.error.message },
          "overview schema mismatch",
        );
        return this.cacheOverview(owner, null);
      }
      return this.cacheOverview(owner, mapOverview(parsed.data));
    } catch (err) {
      log.debug(
        {
          owner,
          err: err instanceof Error ? err.message : String(err),
        },
        "lpagent overview failed",
      );
      return this.cacheOverview(owner, null);
    }
  }

  /**
   * All currently open positions with per-position PnL (USD + SOL).
   */
  async getOpening(owner: string): Promise<LpAgentOpeningPosition[]> {
    if (!owner) return [];
    const cached = this.openingCache.get(owner);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const { data } = await this.http.get(
        `/open-api/v1/lp-positions/opening`,
        { params: { owner } },
      );
      if (data.status !== "success" || !Array.isArray(data.data)) {
        log.warn({ owner, data }, "unexpected opening response shape");
        return this.cacheOpening(owner, []);
      }
      const results: LpAgentOpeningPosition[] = [];
      for (const item of data.data) {
        const parsed = OpeningPositionSchema.safeParse(item);
        if (parsed.success) {
          results.push(mapOpening(parsed.data));
        } else {
          log.debug(
            { err: parsed.error.message },
            "opening item schema mismatch, skipping",
          );
        }
      }
      return this.cacheOpening(owner, results);
    } catch (err) {
      log.debug(
        {
          owner,
          err: err instanceof Error ? err.message : String(err),
        },
        "lpagent opening failed",
      );
      return this.cacheOpening(owner, []);
    }
  }

  /**
   * Historical (closed) positions with realized PnL.
   */
  async getHistory(owner: string): Promise<LpAgentHistoryItem[]> {
    if (!owner) return [];
    const cached = this.historyCache.get(owner);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const { data } = await this.http.get(
        `/open-api/v1/lp-positions/history`,
        { params: { owner } },
      );
      if (data.status !== "success" || !Array.isArray(data.data)) {
        log.warn({ owner, data }, "unexpected history response shape");
        return this.cacheHistory(owner, []);
      }
      const results: LpAgentHistoryItem[] = [];
      for (const item of data.data) {
        const parsed = HistoryItemSchema.safeParse(item);
        if (parsed.success) {
          results.push(mapHistory(parsed.data));
        } else {
          log.debug(
            { err: parsed.error.message },
            "history item schema mismatch, skipping",
          );
        }
      }
      return this.cacheHistory(owner, results);
    } catch (err) {
      log.debug(
        {
          owner,
          err: err instanceof Error ? err.message : String(err),
        },
        "lpagent history failed",
      );
      return this.cacheHistory(owner, []);
    }
  }

  // ─── Cache helpers ────────────────────────────────────────────────

  private cacheOverview(
    key: string,
    value: LpAgentOverview | null,
  ): LpAgentOverview | null {
    this.overviewCache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return value;
  }

  private cacheOpening(
    key: string,
    value: LpAgentOpeningPosition[],
  ): LpAgentOpeningPosition[] {
    this.openingCache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return value;
  }

  private cacheHistory(
    key: string,
    value: LpAgentHistoryItem[],
  ): LpAgentHistoryItem[] {
    this.historyCache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return value;
  }
}
