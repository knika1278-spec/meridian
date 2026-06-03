import { PublicKey, type Connection } from "@solana/web3.js";
import type { CapitalConfig } from "../types/index.js";
import type { WalletTools } from "../tools/wallet.tools.js";
import type { JupiterTools } from "../tools/jupiter.tools.js";
import type { JupiterSwapClient } from "../tools/jupiter-swap.tools.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("capital-manager");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_UNITS_PER_TOKEN = 1_000_000;

export interface CapitalSnapshot {
  solAmount: number;
  usdcAmount: number;
  solPriceUsd: number;
  totalUsd: number;
  reserveSolUsd: number;
  swappableUsd: number;
  currentUsdcFraction: number;
  targetUsdcFraction: number;
  driftPct: number;
}

export interface RebalanceResult {
  snapshotBefore: CapitalSnapshot;
  action: "none" | "swap_sol_to_usdc" | "swap_usdc_to_sol";
  reason: string;
  swapInputMint?: string;
  swapInputAmount?: string;
  swapOutputMint?: string;
  swapOutputAmount?: string;
  signature?: string;
  dryRun: boolean;
}

export interface CapitalManagerOptions {
  config: CapitalConfig;
  connection: Connection;
  wallet: WalletTools;
  jupiter: JupiterTools;
  jupiterSwap: JupiterSwapClient;
  dryRun: boolean;
}

function emptySnapshot(targetUsdcFraction: number): CapitalSnapshot {
  return {
    solAmount: 0,
    usdcAmount: 0,
    solPriceUsd: 0,
    totalUsd: 0,
    reserveSolUsd: 0,
    swappableUsd: 0,
    currentUsdcFraction: 0,
    targetUsdcFraction,
    driftPct: 0,
  };
}

/**
 * Reads the bot wallet's SOL + USDC balances and auto-swaps via Jupiter to
 * maintain a target USDC fraction. Run at startup so the wallet always has
 * both pair tokens before opening DLMM positions.
 */
export class CapitalManager {
  private readonly config: CapitalConfig;
  private readonly connection: Connection;
  private readonly wallet: WalletTools;
  private readonly jupiter: JupiterTools;
  private readonly jupiterSwap: JupiterSwapClient;
  private readonly dryRun: boolean;

  constructor(opts: CapitalManagerOptions) {
    this.config = opts.config;
    this.connection = opts.connection;
    this.wallet = opts.wallet;
    this.jupiter = opts.jupiter;
    this.jupiterSwap = opts.jupiterSwap;
    this.dryRun = opts.dryRun;
  }

  /** Read current SOL + USDC balances + SOL price → compute snapshot. */
  async snapshot(): Promise<CapitalSnapshot> {
    if (!this.wallet.isConfigured()) {
      log.warn("snapshot: wallet not configured");
      return emptySnapshot(this.config.targetUsdcFraction);
    }

    const solAmount = await this.wallet.getBalanceSol();
    const usdcAmount = await this.readUsdcBalance();
    const priceMap = await this.jupiter.getPriceUsd([SOL_MINT]);
    const solPriceUsd = priceMap[SOL_MINT] ?? 0;

    const totalUsd = solAmount * solPriceUsd + usdcAmount;
    const reserveSolUsd = this.config.minReserveSol * solPriceUsd;
    const swappableUsd = Math.max(0, totalUsd - reserveSolUsd);
    const currentUsdcFraction =
      swappableUsd > 0
        ? Math.min(1, Math.max(0, usdcAmount / swappableUsd))
        : 0;
    const driftPct =
      Math.abs(currentUsdcFraction - this.config.targetUsdcFraction) * 100;

    return {
      solAmount,
      usdcAmount,
      solPriceUsd,
      totalUsd,
      reserveSolUsd,
      swappableUsd,
      currentUsdcFraction,
      targetUsdcFraction: this.config.targetUsdcFraction,
      driftPct,
    };
  }

  /** Take snapshot, compute drift, swap if drift > threshold. */
  async ensureBalance(): Promise<RebalanceResult> {
    if (!this.config.enabled) {
      const snap = await this.safeSnapshot();
      return {
        snapshotBefore: snap,
        action: "none",
        reason: "capital management disabled",
        dryRun: this.dryRun,
      };
    }

    if (!this.wallet.isConfigured()) {
      return {
        snapshotBefore: emptySnapshot(this.config.targetUsdcFraction),
        action: "none",
        reason:
          "wallet not configured (WALLET_PRIVATE_KEY/PRIVATE_KEY_BOT missing)",
        dryRun: this.dryRun,
      };
    }

    let snap: CapitalSnapshot;
    try {
      snap = await this.snapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, "ensureBalance: snapshot failed");
      return {
        snapshotBefore: emptySnapshot(this.config.targetUsdcFraction),
        action: "none",
        reason: `error: snapshot failed: ${msg}`,
        dryRun: this.dryRun,
      };
    }

    log.info(
      {
        sol: snap.solAmount.toFixed(4),
        usdc: snap.usdcAmount.toFixed(2),
        solPrice: snap.solPriceUsd.toFixed(2),
        totalUsd: snap.totalUsd.toFixed(2),
        swappableUsd: snap.swappableUsd.toFixed(2),
        currentUsdcFraction: snap.currentUsdcFraction.toFixed(3),
        targetUsdcFraction: snap.targetUsdcFraction.toFixed(3),
        driftPct: snap.driftPct.toFixed(2),
      },
      "capital snapshot",
    );

    if (snap.solPriceUsd <= 0) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: "error: SOL price unavailable from Jupiter",
        dryRun: this.dryRun,
      };
    }

    if (snap.swappableUsd <= 0) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: `insufficient capital above minReserveSol (${this.config.minReserveSol} SOL)`,
        dryRun: this.dryRun,
      };
    }

    if (snap.driftPct < this.config.rebalanceThresholdPct) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: `within threshold (drift ${snap.driftPct.toFixed(
          2,
        )}% < ${this.config.rebalanceThresholdPct}%)`,
        dryRun: this.dryRun,
      };
    }

    // Decide direction
    const needMoreUsdc = snap.currentUsdcFraction < snap.targetUsdcFraction;

    // USD value to swap = (|target - current|) × swappableUsd
    const swapUsd =
      Math.abs(snap.targetUsdcFraction - snap.currentUsdcFraction) *
      snap.swappableUsd;

    if (swapUsd <= 0.01) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: `swap value too small ($${swapUsd.toFixed(4)})`,
        dryRun: this.dryRun,
      };
    }

    if (needMoreUsdc) {
      return await this.swapSolToUsdc(snap, swapUsd);
    }
    return await this.swapUsdcToSol(snap, swapUsd);
  }

  // ---- internals ----

  private async safeSnapshot(): Promise<CapitalSnapshot> {
    try {
      return await this.snapshot();
    } catch {
      return emptySnapshot(this.config.targetUsdcFraction);
    }
  }

  private async readUsdcBalance(): Promise<number> {
    try {
      const owner = this.wallet.getPublicKey();
      const mint = new PublicKey(this.config.usdcMint);
      const resp = await this.connection.getParsedTokenAccountsByOwner(
        owner,
        { mint },
        "confirmed",
      );

      let maxUi = 0;
      for (const acc of resp.value) {
        const info = acc.account.data as {
          parsed?: {
            info?: {
              tokenAmount?: { uiAmount?: number | null; amount?: string };
            };
          };
        };
        const ui = info.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof ui === "number" && ui > maxUi) maxUi = ui;
      }
      return maxUi;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "readUsdcBalance failed",
      );
      return 0;
    }
  }

  private async swapSolToUsdc(
    snap: CapitalSnapshot,
    targetSwapUsd: number,
  ): Promise<RebalanceResult> {
    // Enforce minReserveSol: max swap = (currentSol - reserve) * price
    const maxSolToSwap = Math.max(
      0,
      snap.solAmount - this.config.minReserveSol,
    );
    const maxSwapUsd = maxSolToSwap * snap.solPriceUsd;

    if (maxSwapUsd <= 0) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: `cannot swap: SOL balance ${snap.solAmount.toFixed(
          4,
        )} ≤ minReserveSol ${this.config.minReserveSol}`,
        dryRun: this.dryRun,
      };
    }

    const effectiveUsd = Math.min(targetSwapUsd, maxSwapUsd);
    const solToSwap = effectiveUsd / snap.solPriceUsd;
    const lamports = BigInt(Math.floor(solToSwap * LAMPORTS_PER_SOL));

    if (lamports <= 0n) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: "computed swap lamports = 0",
        dryRun: this.dryRun,
      };
    }

    log.info(
      {
        solToSwap: solToSwap.toFixed(6),
        lamports: lamports.toString(),
        targetUsd: targetSwapUsd.toFixed(2),
        effectiveUsd: effectiveUsd.toFixed(2),
      },
      "swap_sol_to_usdc planning",
    );

    return await this.executeSwap({
      snap,
      inputMint: SOL_MINT,
      outputMint: this.config.usdcMint,
      amountRaw: lamports.toString(),
      action: "swap_sol_to_usdc",
    });
  }

  private async swapUsdcToSol(
    snap: CapitalSnapshot,
    targetSwapUsd: number,
  ): Promise<RebalanceResult> {
    const maxUsdcToSwap = snap.usdcAmount; // USDC ~= 1 USD
    if (maxUsdcToSwap <= 0) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: "no USDC available to swap",
        dryRun: this.dryRun,
      };
    }

    const effectiveUsd = Math.min(targetSwapUsd, maxUsdcToSwap);
    const usdcUnits = BigInt(Math.floor(effectiveUsd * USDC_UNITS_PER_TOKEN));

    if (usdcUnits <= 0n) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: "computed swap usdc-units = 0",
        dryRun: this.dryRun,
      };
    }

    log.info(
      {
        usdcToSwap: effectiveUsd.toFixed(2),
        usdcUnits: usdcUnits.toString(),
        targetUsd: targetSwapUsd.toFixed(2),
      },
      "swap_usdc_to_sol planning",
    );

    return await this.executeSwap({
      snap,
      inputMint: this.config.usdcMint,
      outputMint: SOL_MINT,
      amountRaw: usdcUnits.toString(),
      action: "swap_usdc_to_sol",
    });
  }

  private async executeSwap(args: {
    snap: CapitalSnapshot;
    inputMint: string;
    outputMint: string;
    amountRaw: string;
    action: "swap_sol_to_usdc" | "swap_usdc_to_sol";
  }): Promise<RebalanceResult> {
    const { snap, inputMint, outputMint, amountRaw, action } = args;

    const quote = await this.jupiterSwap.getQuote({
      inputMint,
      outputMint,
      amount: amountRaw,
      slippageBps: this.config.slippageBps,
    });

    if (!quote) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: "error: Jupiter quote unavailable",
        swapInputMint: inputMint,
        swapInputAmount: amountRaw,
        swapOutputMint: outputMint,
        dryRun: this.dryRun,
      };
    }

    let userPubkey: PublicKey;
    try {
      userPubkey = this.wallet.getPublicKey();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        snapshotBefore: snap,
        action: "none",
        reason: `error: ${msg}`,
        dryRun: this.dryRun,
      };
    }

    const tx = await this.jupiterSwap.buildSwapTransaction({
      quote,
      userPubkey,
    });

    if (!tx) {
      return {
        snapshotBefore: snap,
        action: "none",
        reason: "error: Jupiter swap-transaction build failed",
        swapInputMint: inputMint,
        swapInputAmount: amountRaw,
        swapOutputMint: outputMint,
        swapOutputAmount: quote.outAmount,
        dryRun: this.dryRun,
      };
    }

    try {
      const result = await this.wallet.signAndSend(tx, {
        dryRun: this.dryRun,
        skipPreflight: false,
      });

      if (result.simulationError) {
        log.warn(
          {
            signature: result.signature,
            simulationError: result.simulationError,
          },
          "swap simulation failed",
        );
        return {
          snapshotBefore: snap,
          action: "none",
          reason: `error: simulation failed: ${result.simulationError}`,
          swapInputMint: inputMint,
          swapInputAmount: amountRaw,
          swapOutputMint: outputMint,
          swapOutputAmount: quote.outAmount,
          signature: result.signature,
          dryRun: this.dryRun,
        };
      }

      const inDecimals = inputMint === SOL_MINT ? SOL_DECIMALS : USDC_DECIMALS;
      const outDecimals =
        outputMint === SOL_MINT ? SOL_DECIMALS : USDC_DECIMALS;
      const inHuman = Number(amountRaw) / Math.pow(10, inDecimals);
      const outHuman = Number(quote.outAmount) / Math.pow(10, outDecimals);

      log.info(
        {
          action,
          signature: result.signature,
          dryRun: result.dryRun,
          inAmount: inHuman.toFixed(6),
          outAmount: outHuman.toFixed(6),
          priceImpactPct: quote.priceImpactPct,
        },
        "swap executed",
      );

      return {
        snapshotBefore: snap,
        action,
        reason: result.dryRun
          ? "dry-run swap simulated"
          : "swap submitted on-chain",
        swapInputMint: inputMint,
        swapInputAmount: amountRaw,
        swapOutputMint: outputMint,
        swapOutputAmount: quote.outAmount,
        signature: result.signature,
        dryRun: result.dryRun,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, "signAndSend threw");
      return {
        snapshotBefore: snap,
        action: "none",
        reason: `error: signAndSend failed: ${msg}`,
        swapInputMint: inputMint,
        swapInputAmount: amountRaw,
        swapOutputMint: outputMint,
        swapOutputAmount: quote.outAmount,
        dryRun: this.dryRun,
      };
    }
  }
}
