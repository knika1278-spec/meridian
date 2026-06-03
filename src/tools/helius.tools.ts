import WebSocket, { type RawData } from "ws";
import { Connection, type Commitment } from "@solana/web3.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("helius-ws");

export function createConnection(
  rpcUrl: string,
  commitment: "processed" | "confirmed" | "finalized",
): Connection {
  // Fail-fast guard: when targeting a Helius endpoint, require a non-empty
  // `api-key` query param. Without this, a bad env substitution silently
  // produces a URL like "?api-key=" and Helius later returns a misleading
  // -32401 "invalid api key provided" deep in the call stack.
  if (rpcUrl.includes("helius-rpc.com")) {
    try {
      const u = new URL(rpcUrl);
      const key = u.searchParams.get("api-key");
      if (!key || key.trim().length < 10) {
        throw new Error(
          `Helius RPC URL is missing api-key query param: ${rpcUrl.replace(/api-key=[^&]*/i, "api-key=<empty>")}\n` +
            `Check HELIUS_API_KEY in .env and that \${HELIUS_API_KEY} substitution worked.`,
        );
      }
    } catch (err) {
      // Re-throw our guard error. Ignore URL-parse failures (let Connection
      // raise its own error if the URL is unparseable).
      if (err instanceof Error && err.message.startsWith("Helius RPC URL")) {
        throw err;
      }
    }
  }
  return new Connection(rpcUrl, { commitment: commitment as Commitment });
}

export async function getConnectionWithFallback(
  primaryUrl: string,
  fallbackUrls: string[],
  commitment: "processed" | "confirmed" | "finalized",
): Promise<Connection> {
  const urls = [primaryUrl, ...fallbackUrls];
  let lastError: unknown = new Error("No RPC URLs provided");

  for (const url of urls) {
    try {
      const conn = createConnection(url, commitment);
      await conn.getSlot();
      if (url !== primaryUrl) {
        log.warn(
          { url: redactUrl(url) },
          "primary RPC unreachable; connected via fallback",
        );
      }
      return conn;
    } catch (err) {
      log.warn(
        { url: redactUrl(url), err: (err as Error).message },
        "RPC connection attempt failed; trying next",
      );
      lastError = err;
    }
  }

  throw lastError;
}

export interface HeliusWsClientOptions {
  wsUrl: string;
  reconnectMaxAttempts: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
}

type MessageHandler = (msg: unknown) => void;
type LifecycleHandler = (info?: unknown) => void;

interface PendingSubscription {
  id: number;
  method: string;
  params: unknown[];
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class HeliusWsClient {
  private readonly opts: HeliusWsClientOptions;
  private ws: WebSocket | null = null;
  private nextSubId = 1;
  private readonly subscriptions = new Map<number, PendingSubscription>();
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly openHandlers = new Set<LifecycleHandler>();
  private readonly closeHandlers = new Set<LifecycleHandler>();
  private readonly errorHandlers = new Set<LifecycleHandler>();

  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting = false;

  constructor(opts: HeliusWsClientOptions) {
    this.opts = opts;
  }

  on(event: "message", handler: MessageHandler): void;
  on(event: "open" | "close" | "error", handler: LifecycleHandler): void;
  on(
    event: "message" | "open" | "close" | "error",
    handler: MessageHandler | LifecycleHandler,
  ): void {
    switch (event) {
      case "message":
        this.messageHandlers.add(handler as MessageHandler);
        break;
      case "open":
        this.openHandlers.add(handler as LifecycleHandler);
        break;
      case "close":
        this.closeHandlers.add(handler as LifecycleHandler);
        break;
      case "error":
        this.errorHandlers.add(handler as LifecycleHandler);
        break;
    }
  }

  /**
   * Register a JSON-RPC subscribe payload. Re-applied on reconnect.
   * Returns the local id for this subscription registration.
   */
  subscribe(method: string, params: unknown[]): number {
    const id = this.nextSubId++;
    const sub: PendingSubscription = { id, method, params };
    this.subscriptions.set(id, sub);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(sub);
    }
    return id;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close(1000, "client stop");
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "error closing socket");
      }
      this.ws = null;
    }
  }

  // --- internals ---

  private async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;

    return new Promise<void>((resolve) => {
      try {
        log.info({ url: redactUrl(this.opts.wsUrl) }, "connecting");
        const ws = new WebSocket(this.opts.wsUrl);
        this.ws = ws;

        ws.on("open", () => {
          this.connecting = false;
          this.reconnectAttempts = 0;
          log.info("websocket open");
          for (const sub of this.subscriptions.values()) {
            this.sendSubscribe(sub);
          }
          this.startHeartbeat();
          for (const h of this.openHandlers) {
            try {
              h();
            } catch (err) {
              log.warn({ err: (err as Error).message }, "open handler threw");
            }
          }
          resolve();
        });

        ws.on("message", (data: RawData) => {
          this.handleMessage(data);
        });

        ws.on("close", (code: number, reason: Buffer) => {
          this.connecting = false;
          this.clearHeartbeat();
          const reasonStr = reason?.toString() ?? "";
          log.warn({ code, reason: reasonStr }, "websocket closed");
          for (const h of this.closeHandlers) {
            try {
              h({ code, reason: reasonStr });
            } catch (err) {
              log.warn({ err: (err as Error).message }, "close handler threw");
            }
          }
          if (!this.stopped) {
            this.scheduleReconnect();
          }
          // Resolve so callers don't hang on initial connect failure;
          // reconnect loop will continue in the background.
          resolve();
        });

        ws.on("error", (err: Error) => {
          log.error({ err: err.message }, "websocket error");
          for (const h of this.errorHandlers) {
            try {
              h(err);
            } catch (handlerErr) {
              log.warn(
                { err: (handlerErr as Error).message },
                "error handler threw",
              );
            }
          }
          // 'close' will fire and trigger reconnect; do not resolve/reject here.
        });
      } catch (err) {
        this.connecting = false;
        log.error(
          { err: (err as Error).message },
          "failed to construct websocket",
        );
        if (!this.stopped) this.scheduleReconnect();
        resolve();
      }
    });
  }

  private sendSubscribe(sub: PendingSubscription): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      jsonrpc: "2.0",
      id: sub.id,
      method: sub.method,
      params: sub.params,
    };
    try {
      this.ws.send(JSON.stringify(payload));
      log.debug({ id: sub.id, method: sub.method }, "sent subscribe");
    } catch (err) {
      log.warn(
        { err: (err as Error).message, id: sub.id },
        "failed to send subscribe",
      );
    }
  }

  private handleMessage(data: RawData): void {
    let parsed: unknown;
    try {
      const text = typeof data === "string" ? data : data.toString("utf-8");
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "failed to parse ws message");
      return;
    }

    // Skip subscribe acks: shape is { jsonrpc, id, result: <subId> } where id matches a registered subscription
    if (isSubscribeAck(parsed, this.subscriptions)) {
      return;
    }

    for (const h of this.messageHandlers) {
      try {
        h(parsed);
      } catch (err) {
        log.warn({ err: (err as Error).message }, "message handler threw");
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= this.opts.reconnectMaxAttempts) {
      log.error(
        { attempts: this.reconnectAttempts },
        "reconnect attempts exhausted; giving up",
      );
      for (const h of this.errorHandlers) {
        try {
          h(new Error("reconnect attempts exhausted"));
        } catch {
          /* swallow */
        }
      }
      this.stopped = true;
      return;
    }

    const attempt = this.reconnectAttempts++;
    const base = this.opts.reconnectBaseDelayMs * 2 ** attempt;
    const capped = Math.min(base, this.opts.reconnectMaxDelayMs);
    const jitter = capped * (0.8 + Math.random() * 0.4); // ±20%
    const delay = Math.round(jitter);

    log.info({ attempt: attempt + 1, delay }, "scheduling reconnect");
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }));
      } catch (err) {
        log.warn({ err: (err as Error).message }, "heartbeat send failed");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// --- helpers ---

function isSubscribeAck(
  msg: unknown,
  pending: Map<number, PendingSubscription>,
): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== "number") return false;
  if (!("result" in m)) return false;
  // ack ids correspond to local subscription ids
  return pending.has(m.id);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("api-key")) {
      u.searchParams.set("api-key", "***");
    }
    return u.toString();
  } catch {
    return url.replace(/api-key=[^&]+/i, "api-key=***");
  }
}
