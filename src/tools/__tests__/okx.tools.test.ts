import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { OkxTools } from "../okx.tools.js";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("OkxTools", () => {
  it("uses public OKX endpoints without an API key and parses risk context", async () => {
    const seenHeaders: string[] = [];
    await withServer(
      (req, res) => {
        seenHeaders.push(String(req.headers["ok-access-client-type"] ?? ""));
        if (req.url?.startsWith("/api/v6/dex/market/token/advanced-info")) {
          sendJson(res, {
            code: "0",
            data: [
              {
                riskControlLevel: "4",
                bundleHoldingPercent: "12.5",
                sniperHoldingPercent: "1.2",
                suspiciousHoldingPercent: "3.4",
                top10HoldPercent: "45.5",
                tokenTags: ["smartMoneyBuy", "dexBoost"],
              },
            ],
          });
          return;
        }
        if (req.url?.startsWith("/priapi/v1/dx/market/v2/risk/new/check")) {
          sendJson(res, {
            code: "0",
            data: {
              riskLevel: "4",
              allAnalysis: {
                highRiskList: [{ riskKey: "isWash", newRiskLabel: "Yes" }],
              },
            },
          });
          return;
        }
        if (req.url === "/api/v6/dex/market/price-info") {
          sendJson(res, {
            code: "0",
            data: [{ price: "2", maxPrice: "4" }],
          });
          return;
        }
        sendJson(res, { code: "404", msg: "missing" }, 404);
      },
      async (baseUrl) => {
        const okx = new OkxTools({
          baseUrl,
          chainShortName: "sol",
          cacheTtlMs: 1,
        });
        const risk = await okx.getTokenRisk(MINT);
        assert.equal(risk.available, true);
        assert.equal(risk.source, "okx-public");
        assert.equal(risk.riskLevel, "4");
        assert.equal(risk.riskScore, 80);
        assert.equal(risk.bundlePct, 12.5);
        assert.equal(risk.sniperPct, 1.2);
        assert.equal(risk.suspiciousPct, 3.4);
        assert.equal(risk.topHoldersPct, 45.5);
        assert.equal(risk.isWash, true);
        assert.equal(risk.smartMoneyBuy, true);
        assert.equal(risk.dexBoost, true);
        assert.equal(risk.priceVsAthPct, 50);
        assert.ok(risk.flags.includes("wash"));
        assert.ok(risk.flags.includes("smart_money_buy"));
        assert.ok(seenHeaders.every((h) => h === "agent-cli"));
      },
    );
  });

  it("returns unavailable-safe values when OKX endpoints fail", async () => {
    await withServer(
      (_req, res) => {
        sendJson(res, { code: "500", msg: "blocked" }, 500);
      },
      async (baseUrl) => {
        const okx = new OkxTools({
          baseUrl,
          cacheTtlMs: 1,
          maxRetries: 0,
        });
        const risk = await okx.getTokenRisk(MINT);
        const smart = await okx.getSmartMoneySignals(MINT);
        assert.equal(risk.available, false);
        assert.deepEqual(risk.flags, []);
        assert.equal(risk.riskScore, undefined);
        assert.equal(smart.available, false);
        assert.deepEqual(smart.lastSignals, []);
        assert.equal(smart.netFlowUsd, undefined);
      },
    );
  });

  it("retries retryable OKX 429 responses", async () => {
    let advancedRequests = 0;
    await withServer(
      (req, res) => {
        if (req.url?.startsWith("/api/v6/dex/market/token/advanced-info")) {
          advancedRequests++;
          if (advancedRequests === 1) {
            sendJson(res, { code: "50011", msg: "Too Many Requests" }, 429);
            return;
          }
          sendJson(res, { code: "0", data: [{ riskControlLevel: "1" }] });
          return;
        }
        if (req.url?.startsWith("/priapi/v1/dx/market/v2/risk/new/check")) {
          sendJson(res, { code: "0", data: {} });
          return;
        }
        if (req.url === "/api/v6/dex/market/price-info") {
          sendJson(res, { code: "0", data: [{}] });
          return;
        }
        sendJson(res, { code: "404", msg: "missing" }, 404);
      },
      async (baseUrl) => {
        const okx = new OkxTools({
          baseUrl,
          cacheTtlMs: 1,
          maxRetries: 1,
          retryBaseDelayMs: 1,
          retryMaxDelayMs: 1,
        });

        const risk = await okx.getTokenRisk(MINT);

        assert.equal(advancedRequests, 2);
        assert.equal(risk.available, true);
        assert.equal(risk.riskLevel, "1");
      },
    );
  });

  it("limits parallel OKX HTTP requests", async () => {
    let active = 0;
    let maxActive = 0;
    let requests = 0;
    await withServer(
      async (req, res) => {
        requests++;
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        active--;
        if (req.url?.startsWith("/api/v6/dex/market/token/advanced-info")) {
          sendJson(res, { code: "0", data: [{ riskControlLevel: "2" }] });
          return;
        }
        if (req.url?.startsWith("/priapi/v1/dx/market/v2/risk/new/check")) {
          sendJson(res, { code: "0", data: {} });
          return;
        }
        if (req.url === "/api/v6/dex/market/price-info") {
          sendJson(res, { code: "0", data: [{}] });
          return;
        }
        sendJson(res, { code: "404", msg: "missing" }, 404);
      },
      async (baseUrl) => {
        const okx = new OkxTools({
          baseUrl,
          cacheTtlMs: 1,
          maxParallelRequests: 1,
          maxRetries: 0,
        });

        const risk = await okx.getTokenRisk(MINT);

        assert.equal(risk.available, true);
        assert.equal(requests, 3);
        assert.equal(maxActive, 1);
      },
    );
  });

  it("uses signed OKX headers when full credentials are provided", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    await withServer(
      (req, res) => {
        seen.push(req.headers);
        if (req.url?.startsWith("/api/v6/dex/market/token/advanced-info")) {
          sendJson(res, { code: "0", data: [{ riskControlLevel: "1" }] });
          return;
        }
        if (req.url?.startsWith("/priapi/v1/dx/market/v2/risk/new/check")) {
          sendJson(res, { code: "0", data: {} });
          return;
        }
        if (req.url === "/api/v6/dex/market/price-info") {
          sendJson(res, { code: "0", data: [{}] });
          return;
        }
        sendJson(res, { code: "404", msg: "missing" }, 404);
      },
      async (baseUrl) => {
        const okx = new OkxTools({
          baseUrl,
          apiKey: "key",
          secretKey: "secret",
          passphrase: "pass",
          projectId: "project",
          cacheTtlMs: 1,
        });
        const risk = await okx.getTokenRisk(MINT);
        assert.equal(risk.source, "okx-signed-public");
        assert.ok(seen.length >= 3);
        for (const headers of seen) {
          assert.equal(headers["ok-access-key"], "key");
          assert.equal(headers["ok-access-passphrase"], "pass");
          assert.equal(headers["ok-access-project"], "project");
          assert.equal(typeof headers["ok-access-sign"], "string");
          assert.equal(headers["ok-access-client-type"], undefined);
        }
      },
    );
  });

  it("falls back to public mode when signed credentials lack project id", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    await withServer(
      (req, res) => {
        seen.push(req.headers);
        if (req.url?.startsWith("/api/v6/dex/market/token/advanced-info")) {
          sendJson(res, { code: "0", data: [{ riskControlLevel: "2" }] });
          return;
        }
        if (req.url?.startsWith("/priapi/v1/dx/market/v2/risk/new/check")) {
          sendJson(res, { code: "0", data: {} });
          return;
        }
        if (req.url === "/api/v6/dex/market/price-info") {
          sendJson(res, { code: "0", data: [{}] });
          return;
        }
        sendJson(res, { code: "404", msg: "missing" }, 404);
      },
      async (baseUrl) => {
        const okx = new OkxTools({
          baseUrl,
          apiKey: "key",
          secretKey: "secret",
          passphrase: "pass",
          cacheTtlMs: 1,
        });
        const risk = await okx.getTokenRisk(MINT);
        assert.equal(risk.source, "okx-public");
        assert.ok(seen.length >= 3);
        for (const headers of seen) {
          assert.equal(headers["ok-access-client-type"], "agent-cli");
          assert.equal(headers["ok-access-key"], undefined);
          assert.equal(headers["ok-access-project"], undefined);
        }
      },
    );
  });
});
