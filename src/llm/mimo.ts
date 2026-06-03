import axios from "axios";
import { childLogger } from "../utils/logger.js";
import {
  stripJsonFence,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./types.js";

const log = childLogger("llm-mimo");

export interface MimoOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface MimoChoice {
  message?: { content?: string };
  finish_reason?: string;
}

interface MimoResponse {
  choices?: MimoChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class MimoProvider implements LlmProvider {
  readonly name = "mimo";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: MimoOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (
      opts.baseUrl ?? "https://token-plan-sgp.xiaomimimo.com/v1"
    ).replace(/\/+$/, "");
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const startTime = Date.now();
    const systemPromptLen = req.systemPrompt?.length ?? 0;
    const userPromptLen = req.userPrompt?.length ?? 0;
    const totalPromptChars = systemPromptLen + userPromptLen;

    const body: Record<string, unknown> = {
      model: this.model,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 1500,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userPrompt },
      ],
    };
    if (req.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    log.debug(
      {
        model: this.model,
        systemPromptLen,
        userPromptLen,
        totalPromptChars,
        estimatedTokens: Math.ceil(totalPromptChars / 4),
        maxTokens: req.maxTokens ?? 1500,
        temperature: req.temperature ?? 0.2,
        jsonMode: req.jsonMode ?? false,
      },
      "llm request sending",
    );

    try {
      const { data } = await axios.post<MimoResponse>(
        `${this.baseUrl}/chat/completions`,
        body,
        {
          timeout: req.timeoutMs ?? 60_000,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
        },
      );

      const elapsedMs = Date.now() - startTime;
      const text = data.choices?.[0]?.message?.content ?? "";
      const raw = stripJsonFence(text);
      const finishReason = data.choices?.[0]?.finish_reason;
      const inputTokens = data.usage?.prompt_tokens;
      const outputTokens = data.usage?.completion_tokens;

      // Detect truncation: finish_reason "length" means output was cut off
      const isTruncated = finishReason === "length";
      const isEmpty = !raw || raw.trim().length === 0;

      // Log response details
      log.info(
        {
          model: this.model,
          elapsedMs,
          responseLen: raw.length,
          finishReason,
          isTruncated,
          isEmpty,
          inputTokens,
          outputTokens,
          totalTokens: data.usage?.total_tokens,
        },
        "llm response received",
      );

      // Warn on problematic responses
      if (isEmpty) {
        log.warn(
          {
            model: this.model,
            finishReason,
            usage: data.usage,
            elapsedMs,
          },
          "llm returned empty content",
        );
      } else if (isTruncated) {
        log.warn(
          {
            model: this.model,
            responseLen: raw.length,
            maxTokens: req.maxTokens ?? 1500,
            inputTokens,
            outputTokens,
          },
          "llm response TRUNCATED (finish_reason=length)",
        );
      }

      // Log raw response for debugging (first 500 chars)
      log.debug(
        {
          rawPreview: raw.slice(0, 500),
          rawSuffix: raw.length > 500 ? `... (${raw.length} total chars)` : "",
        },
        "llm response content",
      );

      return {
        ok: true,
        raw,
        provider: this.name,
        model: this.model,
        usage: {
          inputTokens,
          outputTokens,
        },
      };
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      const msg = describeMimoError(err);
      log.warn(
        {
          err: msg,
          elapsedMs,
          ...(axios.isAxiosError(err) && err.response?.status !== undefined
            ? { status: err.response.status }
            : {}),
        },
        "mimo request failed",
      );
      return {
        ok: false,
        raw: "",
        error: msg,
        provider: this.name,
        model: this.model,
      };
    }
  }
}

function describeMimoError(err: unknown): string {
  if (!axios.isAxiosError(err)) {
    return err instanceof Error ? err.message : String(err);
  }

  const status = err.response?.status;
  const detail = mimoErrorMessage(err.response?.data);
  const pieces = [
    status !== undefined ? `HTTP ${status}` : undefined,
    detail,
    detail ? undefined : err.message,
  ].filter((piece): piece is string => piece !== undefined && piece.length > 0);
  return pieces.join(": ");
}

function mimoErrorMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data.slice(0, 500);
  if (!data || typeof data !== "object") return undefined;

  const root = data as Record<string, unknown>;
  const error = root.error;
  if (error && typeof error === "object") {
    const errorObj = error as Record<string, unknown>;
    const message = errorObj.message;
    const code = errorObj.code;
    const param = errorObj.param;
    return [message, code !== undefined ? `code=${code}` : undefined, param]
      .filter((item): item is string => typeof item === "string")
      .join(" ");
  }

  const message = root.message;
  if (typeof message === "string") return message;

  try {
    return JSON.stringify(root).slice(0, 500);
  } catch {
    return undefined;
  }
}
