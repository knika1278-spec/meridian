import axios, { AxiosInstance, type AxiosRequestConfig } from "axios";
import { z } from "zod";
import { childLogger } from "../utils/logger.js";
import type {
  TokenAuditInfo,
  TokenInfo,
  TokenLaunchpadInfo,
  TokenPriceStats,
} from "../types/index.js";
import {
  JUPITER_PRICE_PATH,
  JUPITER_TOKEN_SEARCH_PATH,
  jupiterPriceParams,
  jupiterTokenSearchParams,
  normalizeJupiterBaseUrl,
} from "../shared/jupiter-endpoints.js";

const log = childLogger("jupiter-tools");
const DEFAULT_MAX_REQUESTS_PER_SECOND = 10;
const DEFAULT_MAX_PARALLEL_REQUESTS = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;

// --- Schemas ---

const NumLike = z.union([z.number(), z.string(), z.null(), z.undefined()]);

/** Audit sub-object that Jupiter sometimes nests under `audit`. */
const AuditSubSchema = z
  .object({
    mintAuthorityDisabled: z.boolean().optional(),
    freezeAuthorityDisabled: z.boolean().optional(),
    topHoldersPercentage: NumLike,
    topHoldersPct: NumLike,
    devMintedPct: NumLike,
    devMigrations: NumLike,
  })
  .passthrough();

/** Item returned by GET /tokens/v2/search?query=... */
const TokenSearchItemSchema = z
  .object({
    id: z.string(), // mint address
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
    icon: z.string().optional(),
    holderCount: NumLike,
    circSupply: NumLike,
    totalSupply: NumLike,
    fdv: NumLike,
    mcap: NumLike,
    usdPrice: NumLike,
    liquidity: NumLike,
    organicScore: NumLike,
    organicScoreLabel: z.string().optional(),
    isVerified: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    audit: AuditSubSchema.optional(),
    mintAuthority: z.union([z.string(), z.null()]).optional(),
    freezeAuthority: z.union([z.string(), z.null()]).optional(),
    launchpad: z.string().optional(),
    graduatedAt: NumLike,
    priceChange24h: NumLike,
    priceChange1h: NumLike,
    priceChange5m: NumLike,
  })
  .passthrough();

type TokenSearchItem = z.infer<typeof TokenSearchItemSchema>;

const TokenSearchResponseSchema = z.array(TokenSearchItemSchema);

/** Value in GET /price/v3?ids=mint1,mint2 (keyed by mint). */
const PriceItemSchema = z
  .object({
    usdPrice: NumLike,
    decimals: z.number().optional(),
    liquidity: NumLike,
    priceChange24h: NumLike,
    blockId: z.number().optional(),
  })
  .passthrough();

const PriceResponseSchema = z.record(z.string(), PriceItemSchema);

// --- Helpers ---

function toNumberSafe(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RequestRateLimiter {
  private readonly intervalMs: number;
  private nextStartAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(maxRequestsPerSecond: number) {
    this.intervalMs =
      Number.isFinite(maxRequestsPerSecond) && maxRequestsPerSecond > 0
        ? Math.ceil(1_000 / maxRequestsPerSecond)
        : 0;
  }

  async waitForTurn(): Promise<void> {
    if (this.intervalMs <= 0) return;

    const turn = this.tail.then(async () => {
      const waitMs = Math.max(0, this.nextStartAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      this.nextStartAt = Date.now() + this.intervalMs;
    });

    this.tail = turn.catch(() => undefined);
    await turn;
  }
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

function mapTokenItem(t: TokenSearchItem): Partial<TokenInfo> {
  const out: Partial<TokenInfo> = { mint: t.id };
  if (t.symbol) out.symbol = t.symbol;
  if (t.name) out.name = t.name;
  if (typeof t.decimals === "number") out.decimals = t.decimals;
  const holders = toNumberSafe(t.holderCount);
  if (holders !== undefined) out.holders = holders;
  const mcap = toNumberSafe(t.mcap);
  if (mcap !== undefined) out.marketCap = mcap;
  const fdv = toNumberSafe(t.fdv);
  if (fdv !== undefined) out.fdv = fdv;
  const price = toNumberSafe(t.usdPrice);
  if (price !== undefined) out.priceUsd = price;
  const organic = toNumberSafe(t.organicScore);
  if (organic !== undefined) out.organicScore = organic;

  const audit = mapAudit(t);
  if (audit) out.audit = audit;
  const launchpad = mapLaunchpad(t);
  if (launchpad) out.launchpad = launchpad;
  const priceStats = mapPriceStats(t);
  if (priceStats) out.priceStats = priceStats;
  return out;
}

function mapAudit(t: TokenSearchItem): TokenAuditInfo | undefined {
  const flags: string[] = [];
  const out: TokenAuditInfo = { flags };
  let touched = false;

  if (typeof t.isVerified === "boolean") {
    out.isVerified = t.isVerified;
    touched = true;
  }
  // Jupiter exposes authorities either nested under `audit` or as top-level
  // `mintAuthority` / `freezeAuthority` (string when active, null/missing when
  // disabled).
  const mintDisabled =
    t.audit?.mintAuthorityDisabled ??
    (t.mintAuthority === null ? true : undefined);
  if (typeof mintDisabled === "boolean") {
    out.mintAuthorityDisabled = mintDisabled;
    touched = true;
    if (!mintDisabled) flags.push("mint-authority-active");
  }
  const freezeDisabled =
    t.audit?.freezeAuthorityDisabled ??
    (t.freezeAuthority === null ? true : undefined);
  if (typeof freezeDisabled === "boolean") {
    out.freezeAuthorityDisabled = freezeDisabled;
    touched = true;
    if (!freezeDisabled) flags.push("freeze-authority-active");
  }
  const top = toNumberSafe(
    t.audit?.topHoldersPct ?? t.audit?.topHoldersPercentage,
  );
  if (top !== undefined) {
    out.topHoldersPct = top;
    touched = true;
  }
  if (t.tags && t.tags.length > 0) {
    out.tags = t.tags;
    touched = true;
  }
  if (!touched && flags.length === 0) return undefined;
  return out;
}

function mapLaunchpad(t: TokenSearchItem): TokenLaunchpadInfo | undefined {
  const tags = t.tags ?? [];
  const launchpad =
    t.launchpad ??
    tags.find((tag) => /pump|raydium|moonshot|jupstudio|believe/i.test(tag));
  if (!launchpad && !t.graduatedAt) return undefined;
  const out: TokenLaunchpadInfo = {};
  if (launchpad) out.launchpad = launchpad;
  const grad = toNumberSafe(t.graduatedAt);
  if (grad !== undefined && grad > 0) {
    out.graduated = true;
    out.graduatedAt = grad;
  }
  return out;
}

function mapPriceStats(t: TokenSearchItem): TokenPriceStats | undefined {
  const out: TokenPriceStats = {};
  let touched = false;
  const price = toNumberSafe(t.usdPrice);
  if (price !== undefined) {
    out.priceUsd = price;
    touched = true;
  }
  const liq = toNumberSafe(t.liquidity);
  if (liq !== undefined) {
    out.liquidity = liq;
    touched = true;
  }
  const c24 = toNumberSafe(t.priceChange24h);
  if (c24 !== undefined) {
    out.priceChange24h = c24;
    touched = true;
  }
  const c1 = toNumberSafe(t.priceChange1h);
  if (c1 !== undefined) {
    out.priceChange1h = c1;
    touched = true;
  }
  const c5 = toNumberSafe(t.priceChange5m);
  if (c5 !== undefined) {
    out.priceChange5m = c5;
    touched = true;
  }
  return touched ? out : undefined;
}

// --- Public API ---

export interface JupiterToolsOptions {
  baseUrl: string;
  apiKey?: string;
  /** Per-mint cache TTL in ms (default 60s). */
  cacheTtlMs?: number;
  /** Jupiter request throttle. Default matches the 10 req/sec paid-tier limit. */
  maxRequestsPerSecond?: number;
  /** Maximum simultaneous HTTP requests to Jupiter. */
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

/**
 * Jupiter v2/v3 API wrapper.
 *
 * - With `apiKey`: routes to `api.jup.ag` and sends `x-api-key` (paid tier,
 *   higher rate limits).
 * - Without `apiKey`: uses `lite-api.jup.ag` (free public tier).
 *
 * All methods are best-effort: network or schema failures log a warning and
 * return empty/partial results — they never throw.
 */
export class JupiterTools {
  private readonly http: AxiosInstance;
  private readonly cacheTtlMs: number;
  private readonly tokenCache = new Map<
    string,
    CacheEntry<Partial<TokenInfo>>
  >();
  private readonly tokenInflight = new Map<
    string,
    Promise<Partial<TokenInfo>>
  >();
  private readonly priceCache = new Map<string, CacheEntry<number>>();
  private readonly rateLimiter: RequestRateLimiter;
  private readonly concurrencyLimiter: RequestConcurrencyLimiter;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly usingPaidTier: boolean;

  constructor(opts: JupiterToolsOptions) {
    const apiKey = opts.apiKey?.trim();
    this.usingPaidTier = !!apiKey;

    const baseUrl = normalizeJupiterBaseUrl(opts.baseUrl, this.usingPaidTier);

    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.rateLimiter = new RequestRateLimiter(
      opts.maxRequestsPerSecond ?? DEFAULT_MAX_REQUESTS_PER_SECOND,
    );
    this.concurrencyLimiter = new RequestConcurrencyLimiter(
      opts.maxParallelRequests ?? DEFAULT_MAX_PARALLEL_REQUESTS,
    );
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs =
      opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = opts.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 15_000,
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
    });

    log.info(
      {
        tier: this.usingPaidTier ? "paid" : "free",
        baseUrl,
        maxRequestsPerSecond:
          opts.maxRequestsPerSecond ?? DEFAULT_MAX_REQUESTS_PER_SECOND,
        maxParallelRequests:
          opts.maxParallelRequests ?? DEFAULT_MAX_PARALLEL_REQUESTS,
        maxRetries: this.maxRetries,
      },
      "jupiter tools initialized",
    );
  }

  /** Token metadata: organic score, holders, market cap, price. */
  async getTokenInfo(mint: string): Promise<Partial<TokenInfo>> {
    if (!mint) return {};
    const cached = this.tokenCache.get(mint);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const inflight = this.tokenInflight.get(mint);
    if (inflight) return inflight;

    const request = this.fetchTokenInfo(mint).finally(() => {
      this.tokenInflight.delete(mint);
    });
    this.tokenInflight.set(mint, request);
    return request;
  }

  private async fetchTokenInfo(mint: string): Promise<Partial<TokenInfo>> {
    try {
      const data = await this.requestWithRetry<unknown>(
        {
          method: "GET",
          url: JUPITER_TOKEN_SEARCH_PATH,
          params: jupiterTokenSearchParams(mint),
        },
        { operation: "tokens/v2/search", mint },
      );
      const parsed = TokenSearchResponseSchema.safeParse(data);
      if (!parsed.success) {
        log.warn(
          { mint, err: parsed.error.message },
          "tokens/v2/search schema mismatch",
        );
        return this.cacheToken(mint, {});
      }
      const match = parsed.data.find((t) => t.id === mint) ?? parsed.data[0];
      if (!match) return this.cacheToken(mint, {});
      return this.cacheToken(mint, mapTokenItem(match));
    } catch (err) {
      log.warn(
        { mint, err: err instanceof Error ? err.message : String(err) },
        "tokens/v2/search failed",
      );
      return this.cacheToken(mint, {});
    }
  }

  /** Batched USD prices keyed by mint. */
  async getPriceUsd(mints: string[]): Promise<Record<string, number>> {
    if (mints.length === 0) return {};

    const out: Record<string, number> = {};
    const now = Date.now();
    const toFetch: string[] = [];
    for (const m of mints) {
      const c = this.priceCache.get(m);
      if (c && c.expiresAt > now) out[m] = c.value;
      else toFetch.push(m);
    }
    if (toFetch.length === 0) return out;

    try {
      const data = await this.requestWithRetry<unknown>(
        {
          method: "GET",
          url: JUPITER_PRICE_PATH,
          params: jupiterPriceParams(toFetch),
        },
        { operation: "price/v3", count: toFetch.length },
      );
      const parsed = PriceResponseSchema.safeParse(data);
      if (!parsed.success) {
        log.warn(
          { count: toFetch.length, err: parsed.error.message },
          "price/v3 schema mismatch",
        );
        return out;
      }
      for (const [mint, item] of Object.entries(parsed.data)) {
        const p = toNumberSafe(item.usdPrice);
        if (p !== undefined) {
          out[mint] = p;
          this.priceCache.set(mint, {
            value: p,
            expiresAt: now + this.cacheTtlMs,
          });
        }
      }
      return out;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "price/v3 fetch failed",
      );
      return out;
    }
  }

  /** Audit-only view derived from the cached token info. */
  async getTokenAudit(mint: string): Promise<TokenAuditInfo | undefined> {
    const info = await this.getTokenInfo(mint);
    return info.audit;
  }

  /** Launchpad metadata derived from the cached token info. */
  async getTokenLaunchpad(
    mint: string,
  ): Promise<TokenLaunchpadInfo | undefined> {
    const info = await this.getTokenInfo(mint);
    return info.launchpad;
  }

  /**
   * Per-mint price stats (priceUsd, priceChange24h, liquidity). Uses the same
   * cached token info as `getTokenInfo` so it is essentially free.
   */
  async getPriceStats(
    mints: string[],
  ): Promise<Record<string, TokenPriceStats>> {
    const out: Record<string, TokenPriceStats> = {};
    if (mints.length === 0) return out;
    const tasks = mints.map(async (m) => {
      const info = await this.getTokenInfo(m);
      if (info.priceStats) out[m] = info.priceStats;
    });
    await Promise.allSettled(tasks);
    return out;
  }

  isPaidTier(): boolean {
    return this.usingPaidTier;
  }

  private async requestWithRetry<T>(
    config: AxiosRequestConfig,
    context: Record<string, unknown>,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        await this.rateLimiter.waitForTurn();
        const response = await this.concurrencyLimiter.run(() =>
          this.http.request<T>(config),
        );
        return response.data;
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
            ...context,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            status: httpStatus(err),
            retryInMs: delayMs,
            err: err instanceof Error ? err.message : String(err),
          },
          "jupiter request retrying",
        );
        attempt++;
        await sleep(delayMs);
      }
    }
  }

  private cacheToken(
    mint: string,
    value: Partial<TokenInfo>,
  ): Partial<TokenInfo> {
    this.tokenCache.set(mint, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return value;
  }
}
