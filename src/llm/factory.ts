import { getMimoApiKey, getMimoBaseUrl } from "../config/config.js";
import type { LLMConfig } from "../types/index.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { MimoProvider } from "./mimo.js";
import type { LlmProvider } from "./types.js";

export function createLlmProvider(config: LLMConfig): LlmProvider {
  switch (config.provider) {
    case "claude-cli":
      return new ClaudeCliProvider({
        binary: config.binary,
        model: config.model,
        skipPermissions: false,
      });
    case "mimo":
      return new MimoProvider({
        apiKey: getMimoApiKey(),
        model: config.model,
        baseUrl: getMimoBaseUrl(config.baseUrl),
      });
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`);
    }
  }
}
