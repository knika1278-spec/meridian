import { spawn } from "node:child_process";
import { childLogger } from "../utils/logger.js";
import {
  stripJsonFence,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./types.js";

const log = childLogger("llm-claude-cli");

export interface ClaudeCliOptions {
  /** Binary name or absolute path. Defaults to 'claude' (PATH lookup). */
  binary?: string;
  /** Model alias: 'sonnet' | 'opus' | 'haiku' | full model id. */
  model?: string;
  /** Pass --dangerously-skip-permissions. Default false. */
  skipPermissions?: boolean;
}

/** Shape of the JSON envelope emitted by `claude -p --output-format json`. */
interface ClaudeCliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  content?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Spawns the locally installed `claude` CLI as a subprocess.
 *
 * Uses the user's existing Claude Code subscription auth — no API key required.
 * The system prompt and user prompt are concatenated and piped via stdin to
 * avoid any shell-escaping concerns with long JSON snapshots on Windows.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-cli";
  readonly model: string;
  private readonly binary: string;
  private readonly skipPermissions: boolean;

  constructor(opts: ClaudeCliOptions = {}) {
    this.binary = opts.binary ?? "claude";
    this.model = opts.model ?? "sonnet";
    this.skipPermissions = opts.skipPermissions ?? false;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const args = ["-p", "--output-format", "json", "--model", this.model];
    if (this.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    const userPayload = req.jsonMode
      ? `${req.userPrompt}\n\nIMPORTANT: respond with a single JSON object only. No markdown fences. No prose before or after.`
      : req.userPrompt;

    // Concatenate system + user into stdin; -p mode treats stdin as the user
    // message. Claude follows the embedded system instructions reliably.
    const combined = [
      "=== SYSTEM INSTRUCTIONS ===",
      req.systemPrompt,
      "",
      "=== USER REQUEST ===",
      userPayload,
    ].join("\n");

    return await this.spawn(
      args,
      combined,
      req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  private spawn(
    args: string[],
    stdinPayload: string,
    timeoutMs: number,
  ): Promise<LlmResponse> {
    return new Promise<LlmResponse>((resolve) => {
      const isWin = process.platform === "win32";
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn(this.binary, args, {
        shell: isWin,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (resp: LlmResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(resp);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* noop */
        }
        finish({
          ok: false,
          raw: "",
          error: `claude CLI timed out after ${timeoutMs}ms`,
          provider: this.name,
          model: this.model,
        });
      }, timeoutMs);

      child.stdout.on("data", (c: Buffer | string) => {
        stdout += typeof c === "string" ? c : c.toString();
      });
      child.stderr.on("data", (c: Buffer | string) => {
        stderr += typeof c === "string" ? c : c.toString();
      });

      child.on("error", (err) => {
        log.error({ err: err.message }, "spawn failed");
        finish({
          ok: false,
          raw: "",
          error: `spawn failed: ${err.message}. Is 'claude' on PATH?`,
          provider: this.name,
          model: this.model,
        });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          finish({
            ok: false,
            raw: stdout,
            error: `claude CLI exit ${code ?? "?"}: ${stderr.slice(0, 400) || "(no stderr)"}`,
            provider: this.name,
            model: this.model,
          });
          return;
        }

        let envelope: ClaudeCliEnvelope | null = null;
        try {
          envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
        } catch (err) {
          log.warn(
            {
              err: (err as Error).message,
              stdoutHead: stdout.slice(0, 200),
            },
            "envelope parse failed; returning raw stdout",
          );
          finish({
            ok: true,
            raw: stripJsonFence(stdout),
            provider: this.name,
            model: this.model,
          });
          return;
        }

        if (envelope.is_error === true) {
          finish({
            ok: false,
            raw: envelope.result ?? "",
            error: `claude CLI reported error: ${envelope.subtype ?? "unknown"}`,
            provider: this.name,
            model: this.model,
          });
          return;
        }

        const text = envelope.result ?? envelope.content ?? "";
        finish({
          ok: true,
          raw: stripJsonFence(text),
          provider: this.name,
          model: this.model,
          usage: {
            inputTokens: envelope.usage?.input_tokens,
            outputTokens: envelope.usage?.output_tokens,
            costUsd: envelope.total_cost_usd,
          },
        });
      });

      child.stdin.write(stdinPayload);
      child.stdin.end();
    });
  }
}
