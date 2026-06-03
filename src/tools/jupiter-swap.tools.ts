import axios, { type AxiosInstance } from "axios";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { childLogger } from "../utils/logger.js";

const log = childLogger("jupiter-swap");

// --- Schemas ---

const QuoteResponseSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string(),
    outAmount: z.string(),
    otherAmountThreshold: z.string(),
    swapMode: z.union([z.literal("ExactIn"), z.literal("ExactOut")]),
    slippageBps: z.number(),
    priceImpactPct: z.union([z.string(), z.number()]).optional(),
    routePlan: z.array(z.unknown()).optional(),
    contextSlot: z.number().optional(),
  })
  .passthrough();

const SwapResponseSchema = z
  .object({
    swapTransaction: z.string(),
    lastValidBlockHeight: z.number().optional(),
    prioritizationFeeLamports: z.number().optional(),
  })
  .passthrough();

// --- Public types ---

export interface JupiterSwapOptions {
  /** Base URL — same as JupiterTools (lite-api.jup.ag or api.jup.ag). */
  baseUrl: string;
  apiKey?: string;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: number;
  routePlan: unknown[];
  contextSlot?: number;
  /** Original unparsed Jupiter response — required as input to /swap. */
  raw: unknown;
}

export interface SwapQuoteInput {
  inputMint: string;
  outputMint: string;
  /** Raw u64 amount of input. */
  amount: string;
  slippageBps: number;
}

export interface BuildSwapArgs {
  quote: SwapQuote;
  userPubkey: PublicKey;
  /** Optional priority fee in lamports (passed through to Jupiter). */
  priorityFeeLamports?: number;
}

// --- Helpers ---

function toNumberSafe(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Jupiter swap client (v1 endpoints).
 *
 * - With `apiKey`: routes to `api.jup.ag` with `x-api-key` (paid tier).
 * - Without `apiKey`: uses `lite-api.jup.ag` (free public tier).
 *
 * All methods are best-effort: failures log a warning and return null —
 * they never throw.
 */
export class JupiterSwapClient {
  private readonly http: AxiosInstance;
  private readonly usingPaidTier: boolean;

  constructor(opts: JupiterSwapOptions) {
    const apiKey = opts.apiKey?.trim();
    this.usingPaidTier = !!apiKey;

    let baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (this.usingPaidTier && baseUrl.includes("lite-api.jup.ag")) {
      baseUrl = baseUrl.replace("lite-api.jup.ag", "api.jup.ag");
    }

    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 20_000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
    });

    log.info(
      { tier: this.usingPaidTier ? "paid" : "free", baseUrl },
      "jupiter swap client initialized",
    );
  }

  isPaidTier(): boolean {
    return this.usingPaidTier;
  }

  /** Fetch quote (no signing). Returns null on any error. */
  async getQuote(input: SwapQuoteInput): Promise<SwapQuote | null> {
    if (!input.inputMint || !input.outputMint) {
      log.warn({ input }, "getQuote: missing mints");
      return null;
    }
    if (!input.amount || input.amount === "0") {
      log.warn({ input }, "getQuote: zero amount");
      return null;
    }

    try {
      const { data } = await this.http.get("/swap/v1/quote", {
        params: {
          inputMint: input.inputMint,
          outputMint: input.outputMint,
          amount: input.amount,
          slippageBps: input.slippageBps,
        },
      });

      const parsed = QuoteResponseSchema.safeParse(data);
      if (!parsed.success) {
        log.warn(
          { err: parsed.error.message, input },
          "swap/v1/quote schema mismatch",
        );
        return null;
      }

      const q = parsed.data;
      return {
        inputMint: q.inputMint,
        outputMint: q.outputMint,
        inAmount: q.inAmount,
        outAmount: q.outAmount,
        otherAmountThreshold: q.otherAmountThreshold,
        swapMode: q.swapMode,
        slippageBps: q.slippageBps,
        priceImpactPct: toNumberSafe(q.priceImpactPct, 0),
        routePlan: q.routePlan ?? [],
        ...(typeof q.contextSlot === "number"
          ? { contextSlot: q.contextSlot }
          : {}),
        raw: data,
      };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), input },
        "swap/v1/quote failed",
      );
      return null;
    }
  }

  /** Build an unsigned VersionedTransaction from quote + user pubkey. */
  async buildSwapTransaction(
    args: BuildSwapArgs,
  ): Promise<VersionedTransaction | null> {
    const body: Record<string, unknown> = {
      quoteResponse: args.quote.raw,
      userPublicKey: args.userPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    };

    if (
      typeof args.priorityFeeLamports === "number" &&
      args.priorityFeeLamports > 0
    ) {
      body.prioritizationFeeLamports = args.priorityFeeLamports;
    }

    try {
      const { data } = await this.http.post("/swap/v1/swap", body);

      const parsed = SwapResponseSchema.safeParse(data);
      if (!parsed.success) {
        log.warn({ err: parsed.error.message }, "swap/v1/swap schema mismatch");
        return null;
      }

      const buf = Buffer.from(parsed.data.swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(buf);
      return tx;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "swap/v1/swap failed",
      );
      return null;
    }
  }
}
