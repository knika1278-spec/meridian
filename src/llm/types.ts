export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** When true, instructs the model to emit a single JSON object only. */
  jsonMode?: boolean;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface LlmResponse {
  /** True when the call succeeded and `raw` was returned. */
  ok: boolean;
  /** Raw model text (markdown fences stripped when present). */
  raw: string;
  /** Provider-specific error description when ok=false. */
  error?: string;
  usage?: LlmUsage;
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
}

/** Strip ```json ... ``` fences that LLMs sometimes emit despite instructions. */
export function stripJsonFence(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}
