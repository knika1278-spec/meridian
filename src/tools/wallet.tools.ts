import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { childLogger } from "../utils/logger.js";

const log = childLogger("wallet");

export interface WalletToolsOptions {
  connection: Connection;
  /**
   * Base58-encoded 64-byte secret key. When absent, the wallet is "unconfigured"
   * and operations that require signing throw with a clear message.
   */
  privateKeyBase58?: string;
}

export interface SignAndSendOptions {
  dryRun?: boolean;
  skipPreflight?: boolean;
  /** micro-lamports per CU; optional priority fee */
  computeUnitPrice?: number;
}

export interface SignAndSendResult {
  signature: string;
  dryRun: boolean;
  simulationLogs?: string[];
  simulationError?: string;
}

function maskPubkey(pk: string): string {
  if (pk.length <= 8) return pk;
  return `…${pk.slice(-6)}`;
}

function syntheticDryRunSignature(): string {
  return `dryRun-${randomBytes(16).toString("hex")}`;
}

function isVersionedTransaction(
  tx: Transaction | VersionedTransaction,
): tx is VersionedTransaction {
  return (
    typeof (tx as { version?: unknown }).version !== "undefined" &&
    typeof (tx as { serialize?: unknown }).serialize === "function" &&
    !(tx instanceof Transaction)
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnsupportedPreflightError(err: unknown): boolean {
  const message = errMessage(err);
  const txMessage =
    err && typeof err === "object" && "transactionMessage" in err
      ? String((err as { transactionMessage?: unknown }).transactionMessage)
      : "";
  return `${message}\n${txMessage}`
    .toLowerCase()
    .includes("preflight check is not supported");
}

export class WalletTools {
  private readonly connection: Connection;
  private readonly keypair: Keypair | null;

  constructor(opts: WalletToolsOptions) {
    this.connection = opts.connection;
    if (opts.privateKeyBase58 && opts.privateKeyBase58.trim().length > 0) {
      const decoded: Uint8Array = bs58.decode(opts.privateKeyBase58.trim());
      if (decoded.length !== 64) {
        throw new Error(
          `Invalid bot private key length: expected 64 bytes, got ${decoded.length}.`,
        );
      }
      this.keypair = Keypair.fromSecretKey(decoded);
      log.info(
        { signer: maskPubkey(this.keypair.publicKey.toBase58()) },
        "wallet configured",
      );
    } else {
      this.keypair = null;
      log.warn(
        "wallet NOT configured (WALLET_PRIVATE_KEY/PRIVATE_KEY_BOT missing); signing operations will throw",
      );
    }
  }

  isConfigured(): boolean {
    return this.keypair !== null;
  }

  getKeypair(): Keypair {
    if (!this.keypair) {
      throw new Error(
        "Bot wallet not configured. Set WALLET_PRIVATE_KEY or PRIVATE_KEY_BOT in .env.",
      );
    }
    return this.keypair;
  }

  getPublicKey(): PublicKey {
    return this.getKeypair().publicKey;
  }

  async getBalanceSol(): Promise<number> {
    if (!this.keypair) return 0;
    try {
      const lamports = await this.connection.getBalance(
        this.keypair.publicKey,
        "confirmed",
      );
      return lamports / 1_000_000_000;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "getBalance failed",
      );
      return 0;
    }
  }

  async signAndSend(
    tx: Transaction | VersionedTransaction,
    opts: SignAndSendOptions & { extraSigners?: Keypair[] } = {},
  ): Promise<SignAndSendResult> {
    const dryRun = opts.dryRun === true;
    const extraSigners = opts.extraSigners ?? [];

    // Apply priority fee for legacy transactions (skip for versioned: caller owns the message)
    if (
      !isVersionedTransaction(tx) &&
      typeof opts.computeUnitPrice === "number" &&
      opts.computeUnitPrice > 0
    ) {
      const legacy = tx as Transaction;
      const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: opts.computeUnitPrice,
      });
      // Place priority fee instruction BEFORE other instructions
      legacy.instructions = [priorityIx, ...legacy.instructions];
    }

    // Ensure recent blockhash on legacy transactions
    let blockhash: string | undefined;
    let lastValidBlockHeight: number | undefined;
    if (!isVersionedTransaction(tx)) {
      const legacy = tx as Transaction;
      if (!legacy.recentBlockhash || !legacy.feePayer) {
        const latest = await this.connection.getLatestBlockhash("confirmed");
        blockhash = latest.blockhash;
        lastValidBlockHeight = latest.lastValidBlockHeight;
        if (!legacy.recentBlockhash) legacy.recentBlockhash = blockhash;
        if (!legacy.feePayer && this.keypair) {
          legacy.feePayer = this.keypair.publicKey;
        }
      } else {
        blockhash = legacy.recentBlockhash;
      }
    }

    // ---- DRY RUN ----
    if (dryRun) {
      try {
        const signerKp = this.keypair;
        let simResult;
        if (isVersionedTransaction(tx)) {
          if (signerKp) {
            try {
              tx.sign([signerKp, ...extraSigners]);
            } catch {
              // Sign best-effort; simulation may still work without signatures
            }
          }
          simResult = await this.connection.simulateTransaction(tx, {
            commitment: "confirmed",
            sigVerify: false,
          });
        } else {
          const legacy = tx as Transaction;
          simResult = await this.connection.simulateTransaction(
            legacy,
            signerKp ? [signerKp, ...extraSigners] : undefined,
          );
        }
        const value = simResult.value;
        const logs = (value.logs ?? []).slice(0, 50);
        const errStr = value.err
          ? typeof value.err === "string"
            ? value.err
            : JSON.stringify(value.err)
          : undefined;

        const signature = syntheticDryRunSignature();
        if (errStr) {
          log.warn(
            { signature, simulationError: errStr },
            "dryRun simulation failed",
          );
        } else {
          log.info(
            {
              signature,
              signer: this.keypair
                ? maskPubkey(this.keypair.publicKey.toBase58())
                : "unconfigured",
            },
            "dryRun simulation ok",
          );
        }
        return {
          signature,
          dryRun: true,
          simulationLogs: logs,
          ...(errStr ? { simulationError: errStr } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, "dryRun simulation threw");
        return {
          signature: syntheticDryRunSignature(),
          dryRun: true,
          simulationError: msg,
        };
      }
    }

    // ---- LIVE SEND ----
    const signerKp = this.getKeypair();
    try {
      let rawTx: Uint8Array;
      if (isVersionedTransaction(tx)) {
        tx.sign([signerKp, ...extraSigners]);
        rawTx = tx.serialize();
      } else {
        const legacy = tx as Transaction;
        if (extraSigners.length > 0) {
          legacy.partialSign(...extraSigners);
        }
        legacy.partialSign(signerKp);
        rawTx = legacy.serialize();
      }

      const sendOpts = {
        skipPreflight: opts.skipPreflight ?? false,
        preflightCommitment: "confirmed" as const,
      };
      let signature: string;
      try {
        signature = await this.connection.sendRawTransaction(rawTx, sendOpts);
      } catch (err) {
        if (sendOpts.skipPreflight || !isUnsupportedPreflightError(err)) {
          throw err;
        }
        log.warn(
          { err: errMessage(err) },
          "rpc does not support preflight; retrying with skipPreflight",
        );
        signature = await this.connection.sendRawTransaction(rawTx, {
          ...sendOpts,
          skipPreflight: true,
        });
      }

      log.info(
        { signature, signer: maskPubkey(signerKp.publicKey.toBase58()) },
        "tx sent",
      );

      if (blockhash && typeof lastValidBlockHeight === "number") {
        await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        );
      } else {
        const latest = await this.connection.getLatestBlockhash("confirmed");
        await this.connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed",
        );
      }

      return { signature, dryRun: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "tx send failed");
      throw err instanceof Error ? err : new Error(msg);
    }
  }
}
