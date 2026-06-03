import crypto from "node:crypto";
import axios, { AxiosInstance } from "axios";
import { childLogger } from "../utils/logger.js";
import {
  OKX_PRICE_INFO_PATH,
  okxAdvancedInfoPath,
  okxClusterListPath,
  okxPriceInfoBody,
  okxRiskCheckPath,
  resolveOkxChainIndex,
} from "../shared/okx-web3-endpoints.js";

const log = childLogger("okx-tools");

const PUBLIC_HEADERS = { "Ok-Access-Client-type": "agent-cli" };
const DEFAULT_MAX_PARALLEL_REQUESTS = 2;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;

// --- Public types ---

export interface OkxTokenRisk {
  available?: boolean;
  source?: string;
  riskLevel?: string;
  riskScore?: number;
  flags: string[];
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  topHoldersPct?: number;
  bundlePct?: number;
  sniperPct?: number;
  suspiciousPct?: number;
  devHoldingPct?: number;
  lpBurnedPct?: number;
  totalFeeSol?: number;
  devRugCount?: number;
  devTokenCount?: number;
  creator?: string;
  tags?: string[];
  isHoneypot?: boolean;
  isRugpull?: boolean;
  isWash?: boolean;
  smartMoneyBuy?: boolean;
  devSoldAll?: boolean;
  devBuyingMore?: boolean;
  lowLiquidity?: boolean;
  dexBoost?: boolean;
  dexScreenerPaid?: boolean;
  priceVsAthPct?: number;
  ath?: number;
}

export interface OkxSmartMoneySignal {
  wallet?: string;
  side?: "buy" | "sell";
  amountUsd?: number;
  timestamp?: number;
}

export interface OkxSmartMoneySignals {
  available?: boolean;
  source?: string;
  netFlowUsd?: number;
  buyersCount?: number;
  sellersCount?: number;
  lastSignals: OkxSmartMoneySignal[];
  smartMoneyBuy?: boolean;
  kolInClusters?: boolean;
  topClusterTrend?: string;
  topClusterHoldPct?: number;
}

export interface OkxToolsOptions {
  /**
   * Base URL for OKX Web3. "https://web3.okx.com" is preferred, but
   * legacy values such as "https://web3.okx.com/api/v5" are normalized.
   */
  baseUrl: string;
  /** Optional signed-auth credentials. projectId is required for signed mode. */
  apiKey?: string;
  secretKey?: string;
  passphrase?: string;
  projectId?: string;
  /** Set false to disable every OKX lookup. Default true. */
  enabled?: boolean;
  /** Per-mint cache TTL (default 60s). */
  cacheTtlMs?: number;
  /** Chain identifier OKX uses for Solana: "sol", "solana", or "501". */
  chainShortName?: string;
  /** Maximum simultaneous HTTP requests to OKX. */
  maxParallelRequests?: number;
  /** Retries for retryable HTTP failures such as 429 and 5xx. */
  maxRetries?: number;
  /** Initial retry backoff in ms. */
  retryBaseDelayMs?: number;
  /** Maximum retry backoff in ms. */
  retryMaxDelayMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

type UnknownRecord = Record<string, unknown>;

interface OkxAdvancedInfo {
  riskLevel?: number;
  bundlePct?: number;
  sniperPct?: number;
  suspiciousPct?: number;
  devHoldingPct?: number;
  top10Pct?: number;
  lpBurnedPct?: number;
  totalFeeSol?: number;
  devRugCount?: number;
  devTokenCount?: number;
  creator?: string;
  tags: string[];
  isHoneypot?: boolean;
  smartMoneyBuy?: boolean;
  devSoldAll?: boolean;
  devBuyingMore?: boolean;
  lowLiquidity?: boolean;
  dexBoost?: boolean;
  dexScreenerPaid?: boolean;
}

interface OkxRiskFlags {
  isRugpull?: boolean;
  isWash?: boolean;
  riskLevel?: number;
}

interface OkxCluster {
  holdingPct?: number;
  trend?: string;
  avgHoldDays?: number;
  pnlPct?: number;
  buyVolUsd?: number;
  sellVolUsd?: number;
  avgBuyPrice?: number;
  hasKol?: boolean;
  addressCount?: number;
}

interface OkxPriceInfo {
  price?: number;
  ath?: number;
  atl?: number;
  priceVsAthPct?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  volume5m?: number;
  volume1h?: number;
  holders?: number;
  marketCap?: number;
  liquidity?: number;
}

function toNumberSafe(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RequestConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function toIntSafe(value: unknown): number | undefined {
  const n = toNumberSafe(value);
  return n === undefined ? undefined : Math.trunc(n);
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function firstRecord(value: unknown): UnknownRecord | undefined {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function unwrapEnvelope(payload: unknown): unknown {
  const envelope = asRecord(payload);
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, "data")) {
    return payload;
  }
  return envelope.data;
}

function isOkxErrorEnvelope(payload: unknown): string | undefined {
  const envelope = asRecord(payload);
  if (!envelope) return undefined;
  const code = envelope.code;
  if (code === undefined || code === null || code === "0" || code === 0) {
    return undefined;
  }
  const msg = envelope.msg ?? envelope.message ?? "unknown";
  return `OKX error ${String(code)}: ${String(msg)}`;
}

function normalizeSide(s: string | undefined): "buy" | "sell" | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (["buy", "in", "long", "up", "increase"].includes(v)) return "buy";
  if (["sell", "out", "short", "down", "decrease"].includes(v)) {
    return "sell";
  }
  return undefined;
}

function normalizeOkxBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return trimmed;
  }
}

function appendFlag(
  flags: string[],
  flag: string,
  active: boolean | undefined,
) {
  if (active === true && !flags.includes(flag)) flags.push(flag);
}

function riskLevelToScore(level: number | undefined): number | undefined {
  if (level === undefined) return undefined;
  if (level > 5) return level;
  return Math.max(0, Math.min(100, level * 20));
}

function hasUsefulRiskData(risk: OkxTokenRisk): boolean {
  return (
    risk.available === true ||
    risk.flags.length > 0 ||
    risk.riskLevel !== undefined ||
    risk.riskScore !== undefined
  );
}

function hasUsefulSmartData(signals: OkxSmartMoneySignals): boolean {
  return (
    signals.available === true ||
    signals.netFlowUsd !== undefined ||
    signals.lastSignals.length > 0 ||
    signals.smartMoneyBuy === true ||
    signals.kolInClusters === true
  );
}

function isAffirmative(label: unknown): boolean {
  return typeof label === "string" && label.trim().toLowerCase() === "yes";
}

function collectRiskEntries(section: unknown): UnknownRecord[] {
  const record = asRecord(section);
  if (!record) return [];
  const out: UnknownRecord[] = [];
  for (const key of ["highRiskList", "middleRiskList", "lowRiskList"]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const entry = asRecord(item);
      if (entry) out.push(entry);
    }
  }
  return out;
}

function tagSet(tags: string[]): Set<string> {
  return new Set(tags.map((t) => t.trim().toLowerCase()));
}

function describeOkxFailure(err: unknown): Record<string, unknown> {
  const e = err as {
    message?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: unknown };
    cause?: { message?: unknown; code?: unknown };
  };
  const responseData = asRecord(e?.response?.data);
  const out: Record<string, unknown> = {
    message:
      typeof e?.message === "string" && e.message ? e.message : String(err),
  };
  if (e?.code) out.code = e.code;
  if (e?.response?.status) out.status = e.response.status;
  if (responseData?.code) out.okxCode = responseData.code;
  const okxMessage = responseData?.msg ?? responseData?.message;
  if (okxMessage) out.okxMessage = okxMessage;
  if (e?.cause?.code) out.causeCode = e.cause.code;
  if (e?.cause?.message) out.causeMessage = e.cause.message;
  return out;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const maybeGetter = (headers as { get?: unknown }).get;
  if (typeof maybeGetter === "function") {
    const value = maybeGetter.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function getRetryAfterDelayMs(err: unknown): number | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const header = getHeader(err.response?.headers, "retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function httpStatus(err: unknown): number | undefined {
  return axios.isAxiosError(err) ? err.response?.status : undefined;
}

function isRetryableHttpError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === undefined || status === 429 || status >= 500;
}

function retryDelayMs(
  err: unknown,
  failedAttemptIndex: number,
  baseMs: number,
  maxMs: number,
): number {
  const retryAfter = getRetryAfterDelayMs(err);
  if (retryAfter !== undefined) return Math.min(retryAfter, maxMs);
  const exponential = baseMs * 2 ** failedAttemptIndex;
  const jitter = Math.floor(Math.random() * Math.max(1, baseMs / 2));
  return Math.min(maxMs, exponential + jitter);
}

/**
 * OKX Web3 connector - public DEX enrichment by default, signed auth optional.
 *
 * All methods are best-effort. Network, schema, or regional availability
 * failures log at debug level and return unavailable-safe empty results. That
 * keeps the screening pipeline moving while preventing "no data" from being
 * interpreted as "zero risk".
 */
export class OkxTools {
  private readonly http: AxiosInstance;
  private readonly cacheTtlMs: number;
  private readonly chainIndex: string;
  private readonly enabled: boolean;
  private readonly apiKey?: string;
  private readonly secretKey?: string;
  private readonly passphrase?: string;
  private readonly projectId?: string;
  private readonly sourceLabel: string;
  private readonly concurrencyLimiter: RequestConcurrencyLimiter;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly riskCache = new Map<string, CacheEntry<OkxTokenRisk>>();
  private readonly smartCache = new Map<
    string,
    CacheEntry<OkxSmartMoneySignals>
  >();
  private readonly advancedInfoInflight = new Map<
    string,
    Promise<OkxAdvancedInfo | undefined>
  >();
  private lastFailureWarnAt = 0;

  constructor(opts: OkxToolsOptions) {
    this.enabled = opts.enabled !== false;
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.secretKey = opts.secretKey?.trim() || undefined;
    this.passphrase = opts.passphrase?.trim() || undefined;
    this.projectId = opts.projectId?.trim() || undefined;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.chainIndex = resolveOkxChainIndex(opts.chainShortName);
    this.sourceLabel = this.hasAuth() ? "okx-signed-public" : "okx-public";
    this.concurrencyLimiter = new RequestConcurrencyLimiter(
      opts.maxParallelRequests ?? DEFAULT_MAX_PARALLEL_REQUESTS,
    );
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs =
      opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = opts.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const baseURL = normalizeOkxBaseUrl(opts.baseUrl);
    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      headers: { Accept: "application/json" },
    });
    log.info(
      {
        enabled: this.enabled,
        authenticated: this.hasAuth(),
        signedCredentialsConfigured: this.hasCredentialMaterial(),
        projectIdConfigured: Boolean(this.projectId),
        baseUrl: baseURL,
        chainIndex: this.chainIndex,
        maxParallelRequests:
          opts.maxParallelRequests ?? DEFAULT_MAX_PARALLEL_REQUESTS,
        maxRetries: this.maxRetries,
      },
      "okx tools initialized",
    );
    if (this.hasCredentialMaterial() && !this.projectId) {
      log.warn(
        "okx signed credentials are present but OKX_PROJECT_ID is missing; using public OKX mode",
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Token risk, advanced holder distribution, and price-vs-ATH context. */
  async getTokenRisk(mint: string): Promise<OkxTokenRisk> {
    const empty: OkxTokenRisk = { available: false, flags: [] };
    if (!mint || !this.enabled) return empty;
    const cached = this.riskCache.get(mint);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const [advancedResult, riskResult, priceResult] =
        await Promise.allSettled([
          this.getAdvancedInfo(mint),
          this.getRiskFlags(mint),
          this.getPriceInfo(mint),
        ]);
      const advanced =
        advancedResult.status === "fulfilled"
          ? advancedResult.value
          : undefined;
      const risk =
        riskResult.status === "fulfilled" ? riskResult.value : undefined;
      const price =
        priceResult.status === "fulfilled" ? priceResult.value : undefined;

      if (advancedResult.status !== "fulfilled") {
        this.logLookupFailure("advanced-info", mint, advancedResult.reason);
      }
      if (riskResult.status !== "fulfilled") {
        this.logLookupFailure("risk-check", mint, riskResult.reason);
      }
      if (priceResult.status !== "fulfilled") {
        this.logLookupFailure("price-info", mint, priceResult.reason);
      }

      const available = Boolean(advanced || risk || price);
      const flags: string[] = [];
      appendFlag(flags, "honeypot", advanced?.isHoneypot);
      appendFlag(flags, "rugpull", risk?.isRugpull);
      appendFlag(flags, "wash", risk?.isWash);
      appendFlag(flags, "low_liquidity", advanced?.lowLiquidity);
      appendFlag(flags, "dev_sold_all", advanced?.devSoldAll);
      appendFlag(flags, "dev_buying_more", advanced?.devBuyingMore);
      appendFlag(flags, "smart_money_buy", advanced?.smartMoneyBuy);
      appendFlag(flags, "dex_boost", advanced?.dexBoost);
      appendFlag(flags, "dex_screener_paid", advanced?.dexScreenerPaid);

      const riskLevel = risk?.riskLevel ?? advanced?.riskLevel;
      const tokenRisk: OkxTokenRisk = {
        available,
        source: available ? this.sourceLabel : undefined,
        flags,
      };
      if (riskLevel !== undefined) {
        tokenRisk.riskLevel = String(riskLevel);
        tokenRisk.riskScore = riskLevelToScore(riskLevel);
      }
      if (advanced?.bundlePct !== undefined) {
        tokenRisk.bundlePct = advanced.bundlePct;
      }
      if (advanced?.sniperPct !== undefined)
        tokenRisk.sniperPct = advanced.sniperPct;
      if (advanced?.suspiciousPct !== undefined) {
        tokenRisk.suspiciousPct = advanced.suspiciousPct;
      }
      if (advanced?.devHoldingPct !== undefined) {
        tokenRisk.devHoldingPct = advanced.devHoldingPct;
      }
      if (advanced?.top10Pct !== undefined)
        tokenRisk.topHoldersPct = advanced.top10Pct;
      if (advanced?.lpBurnedPct !== undefined) {
        tokenRisk.lpBurnedPct = advanced.lpBurnedPct;
      }
      if (advanced?.totalFeeSol !== undefined) {
        tokenRisk.totalFeeSol = advanced.totalFeeSol;
      }
      if (advanced?.devRugCount !== undefined) {
        tokenRisk.devRugCount = advanced.devRugCount;
      }
      if (advanced?.devTokenCount !== undefined) {
        tokenRisk.devTokenCount = advanced.devTokenCount;
      }
      if (advanced?.creator) tokenRisk.creator = advanced.creator;
      if (advanced?.tags.length) tokenRisk.tags = advanced.tags;
      if (advanced?.isHoneypot !== undefined) {
        tokenRisk.isHoneypot = advanced.isHoneypot;
      }
      if (risk?.isRugpull !== undefined) tokenRisk.isRugpull = risk.isRugpull;
      if (risk?.isWash !== undefined) tokenRisk.isWash = risk.isWash;
      if (advanced?.smartMoneyBuy !== undefined) {
        tokenRisk.smartMoneyBuy = advanced.smartMoneyBuy;
      }
      if (advanced?.devSoldAll !== undefined)
        tokenRisk.devSoldAll = advanced.devSoldAll;
      if (advanced?.devBuyingMore !== undefined) {
        tokenRisk.devBuyingMore = advanced.devBuyingMore;
      }
      if (advanced?.lowLiquidity !== undefined) {
        tokenRisk.lowLiquidity = advanced.lowLiquidity;
      }
      if (advanced?.dexBoost !== undefined)
        tokenRisk.dexBoost = advanced.dexBoost;
      if (advanced?.dexScreenerPaid !== undefined) {
        tokenRisk.dexScreenerPaid = advanced.dexScreenerPaid;
      }
      if (price?.priceVsAthPct !== undefined) {
        tokenRisk.priceVsAthPct = price.priceVsAthPct;
      }
      if (price?.ath !== undefined) tokenRisk.ath = price.ath;

      return this.cacheRisk(mint, tokenRisk);
    } catch (err) {
      this.logLookupFailure("token-risk", mint, err);
      return this.cacheRisk(mint, empty);
    }
  }

  /** Smart-money and top-cluster signals for a token mint. */
  async getSmartMoneySignals(mint: string): Promise<OkxSmartMoneySignals> {
    const empty: OkxSmartMoneySignals = {
      available: false,
      lastSignals: [],
    };
    if (!mint || !this.enabled) return empty;
    const cached = this.smartCache.get(mint);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const [advancedResult, clusterResult] = await Promise.allSettled([
        this.getAdvancedInfo(mint),
        this.getClusterList(mint),
      ]);
      const advanced =
        advancedResult.status === "fulfilled"
          ? advancedResult.value
          : undefined;
      const clusters =
        clusterResult.status === "fulfilled" ? clusterResult.value : [];

      if (advancedResult.status !== "fulfilled") {
        this.logLookupFailure(
          "smart-advanced-info",
          mint,
          advancedResult.reason,
        );
      }
      if (clusterResult.status !== "fulfilled") {
        this.logLookupFailure("cluster-list", mint, clusterResult.reason);
      }

      const lastSignals: OkxSmartMoneySignal[] = clusters
        .slice(0, 10)
        .map((cluster) => {
          const side = normalizeSide(cluster.trend);
          const sig: OkxSmartMoneySignal = {};
          if (side) sig.side = side;
          const amount =
            side === "sell"
              ? cluster.sellVolUsd
              : side === "buy"
                ? cluster.buyVolUsd
                : Math.max(cluster.buyVolUsd ?? 0, cluster.sellVolUsd ?? 0);
          if (amount !== undefined && amount > 0) sig.amountUsd = amount;
          return sig;
        })
        .filter((sig) => sig.side || sig.amountUsd !== undefined);

      const buyVol = clusters.reduce((sum, c) => sum + (c.buyVolUsd ?? 0), 0);
      const sellVol = clusters.reduce((sum, c) => sum + (c.sellVolUsd ?? 0), 0);
      const netFlowUsd = clusters.some(
        (c) => c.buyVolUsd !== undefined || c.sellVolUsd !== undefined,
      )
        ? buyVol - sellVol
        : undefined;
      const buyersCount = clusters.filter(
        (c) => normalizeSide(c.trend) === "buy",
      ).length;
      const sellersCount = clusters.filter(
        (c) => normalizeSide(c.trend) === "sell",
      ).length;
      const available = Boolean(advanced || clusters.length);
      const signals: OkxSmartMoneySignals = {
        available,
        source: available ? this.sourceLabel : undefined,
        lastSignals,
      };
      if (netFlowUsd !== undefined) signals.netFlowUsd = netFlowUsd;
      if (buyersCount > 0 || advanced?.smartMoneyBuy) {
        signals.buyersCount = Math.max(
          buyersCount,
          advanced?.smartMoneyBuy ? 1 : 0,
        );
      }
      if (sellersCount > 0) signals.sellersCount = sellersCount;
      if (advanced?.smartMoneyBuy !== undefined) {
        signals.smartMoneyBuy = advanced.smartMoneyBuy;
      }
      if (clusters.some((c) => c.hasKol)) signals.kolInClusters = true;
      if (clusters[0]?.trend) signals.topClusterTrend = clusters[0].trend;
      if (clusters[0]?.holdingPct !== undefined) {
        signals.topClusterHoldPct = clusters[0].holdingPct;
      }
      return this.cacheSmart(mint, signals);
    } catch (err) {
      this.logLookupFailure("smart-money", mint, err);
      return this.cacheSmart(mint, empty);
    }
  }

  hasUsefulRiskData(risk: OkxTokenRisk): boolean {
    return hasUsefulRiskData(risk);
  }

  hasUsefulSmartData(signals: OkxSmartMoneySignals): boolean {
    return hasUsefulSmartData(signals);
  }

  private getAdvancedInfo(mint: string): Promise<OkxAdvancedInfo | undefined> {
    const existing = this.advancedInfoInflight.get(mint);
    if (existing) return existing;
    const promise = this._fetchAdvancedInfo(mint).finally(() => {
      this.advancedInfoInflight.delete(mint);
    });
    this.advancedInfoInflight.set(mint, promise);
    return promise;
  }

  private async _fetchAdvancedInfo(
    mint: string,
  ): Promise<OkxAdvancedInfo | undefined> {
    const path = okxAdvancedInfoPath(this.chainIndex, mint);
    const data = await this.okxRequest("GET", path);
    const d = firstRecord(data);
    if (!d) return undefined;
    const tags = asStringArray(d.tokenTags);
    const tagsLower = tagSet(tags);
    return {
      riskLevel: toIntSafe(d.riskControlLevel ?? d.riskLevel),
      bundlePct: toNumberSafe(d.bundleHoldingPercent),
      sniperPct: toNumberSafe(d.sniperHoldingPercent),
      suspiciousPct: toNumberSafe(d.suspiciousHoldingPercent),
      devHoldingPct: toNumberSafe(d.devHoldingPercent),
      top10Pct: toNumberSafe(d.top10HoldPercent),
      lpBurnedPct: toNumberSafe(d.lpBurnedPercent),
      totalFeeSol: toNumberSafe(d.totalFee),
      devRugCount: toIntSafe(d.devRugPullTokenCount),
      devTokenCount: toIntSafe(d.devCreateTokenCount),
      creator:
        typeof d.creatorAddress === "string" ? d.creatorAddress : undefined,
      tags,
      isHoneypot: tagsLower.has("honeypot"),
      smartMoneyBuy: tagsLower.has("smartmoneybuy"),
      devSoldAll: tagsLower.has("devholdingstatussellall"),
      devBuyingMore: tagsLower.has("devholdingstatusbuy"),
      lowLiquidity: tagsLower.has("lowliquidity"),
      dexBoost: tagsLower.has("dexboost"),
      dexScreenerPaid:
        tagsLower.has("dexscreenerpaid") || tagsLower.has("dspaid"),
    };
  }

  private async getRiskFlags(mint: string): Promise<OkxRiskFlags | undefined> {
    const path = okxRiskCheckPath(this.chainIndex, mint);
    const data = await this.okxRequest("GET", path);
    const d = asRecord(data);
    if (!d) return undefined;
    const entries = [
      ...collectRiskEntries(d.allAnalysis),
      ...collectRiskEntries(d.swapAnalysis),
      ...collectRiskEntries(d.contractAnalysis),
      ...collectRiskEntries(d.extraAnalysis),
    ];
    const hasRisk = (riskKey: string) =>
      entries.some(
        (entry) =>
          entry.riskKey === riskKey && isAffirmative(entry.newRiskLabel),
      );
    return {
      isRugpull: hasRisk("isLiquidityRemoval"),
      isWash: hasRisk("isWash"),
      riskLevel: toIntSafe(d.riskLevel ?? d.riskControlLevel),
    };
  }

  private async getClusterList(mint: string, limit = 5): Promise<OkxCluster[]> {
    const path = okxClusterListPath(this.chainIndex, mint);
    const data = await this.okxRequest("GET", path);
    const root = asRecord(data);
    const raw =
      (Array.isArray(root?.clusterList) ? root?.clusterList : undefined) ??
      (Array.isArray(data)
        ? (asRecord(data[0])?.clustList ?? asRecord(data[0])?.clusterList)
        : undefined);
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, limit)
      .map((item): OkxCluster | undefined => {
        const c = asRecord(item);
        if (!c) return undefined;
        const trendRecord = asRecord(c.trendType);
        const addresses = Array.isArray(c.clusterAddressList)
          ? c.clusterAddressList
          : [];
        return {
          holdingPct: toNumberSafe(c.holdingPercent),
          trend:
            (typeof trendRecord?.trendType === "string"
              ? trendRecord.trendType
              : undefined) ??
            (typeof c.trendType === "string" ? c.trendType : undefined),
          avgHoldDays:
            toNumberSafe(c.averageHoldingPeriod) !== undefined
              ? Math.round((toNumberSafe(c.averageHoldingPeriod) ?? 0) / 86_400)
              : undefined,
          pnlPct: toNumberSafe(c.pnlPercent),
          buyVolUsd: toNumberSafe(c.buyVolume),
          sellVolUsd: toNumberSafe(c.sellVolume),
          avgBuyPrice: toNumberSafe(c.averageBuyPriceUsd),
          hasKol: addresses.some((a) => asRecord(a)?.isKol === true),
          addressCount: addresses.length,
        };
      })
      .filter((c): c is OkxCluster => Boolean(c));
  }

  private async getPriceInfo(mint: string): Promise<OkxPriceInfo | undefined> {
    const data = await this.okxRequest(
      "POST",
      OKX_PRICE_INFO_PATH,
      okxPriceInfoBody(this.chainIndex, mint),
    );
    const d = firstRecord(data);
    if (!d) return undefined;
    const price = toNumberSafe(d.price);
    const ath = toNumberSafe(d.maxPrice);
    return {
      price,
      ath,
      atl: toNumberSafe(d.minPrice),
      priceVsAthPct:
        price !== undefined && ath !== undefined && ath > 0
          ? Number(((price / ath) * 100).toFixed(1))
          : undefined,
      priceChange5m: toNumberSafe(d.priceChange5M),
      priceChange1h: toNumberSafe(d.priceChange1H),
      volume5m: toNumberSafe(d.volume5M),
      volume1h: toNumberSafe(d.volume1H),
      holders: toIntSafe(d.holders),
      marketCap: toNumberSafe(d.marketCap),
      liquidity: toNumberSafe(d.liquidity),
    };
  }

  private hasCredentialMaterial(): boolean {
    return Boolean(
      this.apiKey &&
      this.secretKey &&
      this.passphrase &&
      !/enter your passphrase here/i.test(this.passphrase),
    );
  }

  private hasAuth(): boolean {
    return this.hasCredentialMaterial() && Boolean(this.projectId);
  }

  private buildAuthHeaders(
    method: "GET" | "POST",
    path: string,
    bodyText: string,
  ): Record<string, string> {
    const timestamp = new Date().toISOString();
    const prehash = `${timestamp}${method}${path}${bodyText}`;
    const sign = crypto
      .createHmac("sha256", this.secretKey ?? "")
      .update(prehash)
      .digest("base64");
    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": this.apiKey ?? "",
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-PASSPHRASE": this.passphrase ?? "",
      "OK-ACCESS-TIMESTAMP": timestamp,
    };
    if (this.projectId) headers["OK-ACCESS-PROJECT"] = this.projectId;
    return headers;
  }

  private logLookupFailure(
    operation: string,
    mint: string,
    err: unknown,
  ): void {
    log.debug({ mint, operation, err }, "okx lookup failed");
    const now = Date.now();
    if (now - this.lastFailureWarnAt < 60_000) return;
    this.lastFailureWarnAt = now;
    log.warn(
      {
        mint,
        operation,
        error: describeOkxFailure(err),
      },
      "okx lookup unavailable",
    );
  }

  private async okxRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    let attempt = 0;

    while (true) {
      const headers: Record<string, string> = this.hasAuth()
        ? this.buildAuthHeaders(method, path, bodyText)
        : { ...PUBLIC_HEADERS };
      // OKX Web3 examples include Content-Type even for signed GET requests.
      // Keep signed requests byte-for-byte closer to the standalone validator.
      if (this.hasAuth() || body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      try {
        const { data } = await this.concurrencyLimiter.run(() =>
          this.http.request({
            method,
            url: path,
            headers,
            data: body,
          }),
        );
        const err = isOkxErrorEnvelope(data);
        if (err) throw new Error(err);
        return unwrapEnvelope(data);
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryableHttpError(err)) {
          throw err;
        }
        const delayMs = retryDelayMs(
          err,
          attempt,
          this.retryBaseDelayMs,
          this.retryMaxDelayMs,
        );
        log.warn(
          {
            method,
            path,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            status: httpStatus(err),
            retryInMs: delayMs,
            error: describeOkxFailure(err),
          },
          "okx request retrying",
        );
        attempt++;
        await sleep(delayMs);
      }
    }
  }

  private cacheRisk(mint: string, v: OkxTokenRisk): OkxTokenRisk {
    this.riskCache.set(mint, {
      value: v,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return v;
  }

  private cacheSmart(
    mint: string,
    v: OkxSmartMoneySignals,
  ): OkxSmartMoneySignals {
    this.smartCache.set(mint, {
      value: v,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return v;
  }
}
