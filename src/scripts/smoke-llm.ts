import { loadConfig } from "../config/config.js";
import { createLlmProvider } from "../llm/factory.js";

const config = loadConfig();
const llm = createLlmProvider(config.llm);

console.log(`Provider: ${llm.name}`);
console.log(`Model:    ${llm.model}`);
console.log("");
console.log("Calling LLM with a minimal JSON-mode prompt…");
console.log("");

const start = Date.now();
const resp = await llm.generate({
  systemPrompt:
    "You are a JSON-only assistant. Always respond with a single JSON object exactly as requested. Never add markdown fences or prose.",
  userPrompt:
    'Respond with this exact JSON object: {"status":"ok","ping":"pong","provider_check":"meteora-screener"}',
  temperature: 0,
  maxTokens: 200,
  jsonMode: true,
  timeoutMs: 180_000,
});
const durMs = Date.now() - start;

console.log(`Latency: ${durMs} ms`);
console.log(`OK:      ${resp.ok}`);
if (resp.error) console.log(`Error:   ${resp.error}`);
console.log(`Raw output:\n${resp.raw}`);
if (resp.usage) {
  const u = resp.usage;
  console.log(
    `\nUsage: input=${u.inputTokens ?? "?"} output=${u.outputTokens ?? "?"} cost=$${u.costUsd?.toFixed(4) ?? "?"}`,
  );
}

try {
  const parsed: unknown = JSON.parse(resp.raw);
  console.log("\nJSON parse: OK");
  console.log(JSON.stringify(parsed, null, 2));
  process.exit(0);
} catch (err) {
  console.log(`\nJSON parse FAILED: ${(err as Error).message}`);
  process.exit(1);
}
