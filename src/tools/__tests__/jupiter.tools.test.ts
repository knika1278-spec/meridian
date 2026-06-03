import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { JupiterTools } from "../jupiter.tools.js";

const MINT = "So11111111111111111111111111111111111111112";

async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function tokenSearchItem(
  mint: string,
  symbol = "SOL",
): Record<string, unknown> {
  return {
    id: mint,
    symbol,
    name: `${symbol} token`,
    decimals: 9,
    holderCount: "1",
    mcap: "100",
    usdPrice: "85",
    organicScore: "99",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("JupiterTools", () => {
  it("deduplicates concurrent token lookups for the same mint", async () => {
    let requests = 0;
    await withServer(
      (req, res) => {
        requests++;
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        assert.equal(url.pathname, "/tokens/v2/search");
        assert.equal(url.searchParams.get("query"), MINT);
        sendJson(res, [tokenSearchItem(MINT)]);
      },
      async (baseUrl) => {
        const jupiter = new JupiterTools({
          baseUrl,
          cacheTtlMs: 60_000,
          maxRequestsPerSecond: 10,
        });

        const [a, b, c] = await Promise.all([
          jupiter.getTokenInfo(MINT),
          jupiter.getTokenInfo(MINT),
          jupiter.getTokenInfo(MINT),
        ]);

        assert.equal(requests, 1);
        assert.equal(a.symbol, "SOL");
        assert.equal(b.symbol, "SOL");
        assert.equal(c.symbol, "SOL");
      },
    );
  });

  it("retries retryable Jupiter 429 responses", async () => {
    let requests = 0;
    await withServer(
      (_req, res) => {
        requests++;
        if (requests === 1) {
          sendJson(res, { error: "rate limited" }, 429);
          return;
        }
        sendJson(res, [tokenSearchItem(MINT)]);
      },
      async (baseUrl) => {
        const jupiter = new JupiterTools({
          baseUrl,
          cacheTtlMs: 60_000,
          maxRequestsPerSecond: 1000,
          maxRetries: 1,
          retryBaseDelayMs: 1,
          retryMaxDelayMs: 1,
        });

        const info = await jupiter.getTokenInfo(MINT);

        assert.equal(requests, 2);
        assert.equal(info.symbol, "SOL");
      },
    );
  });

  it("limits parallel Jupiter HTTP requests", async () => {
    let active = 0;
    let maxActive = 0;
    let requests = 0;
    await withServer(
      async (req, res) => {
        requests++;
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const mint = url.searchParams.get("query") ?? MINT;
        sendJson(res, [tokenSearchItem(mint, requests === 1 ? "ONE" : "TWO")]);
        active--;
      },
      async (baseUrl) => {
        const jupiter = new JupiterTools({
          baseUrl,
          cacheTtlMs: 1,
          maxRequestsPerSecond: 1000,
          maxParallelRequests: 1,
          maxRetries: 0,
        });

        await Promise.all([
          jupiter.getTokenInfo("Mint111111111111111111111111111111111111111"),
          jupiter.getTokenInfo("Mint222222222222222222222222222222222222222"),
        ]);

        assert.equal(requests, 2);
        assert.equal(maxActive, 1);
      },
    );
  });
});
