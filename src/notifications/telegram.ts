import fs from "node:fs";
import path from "node:path";
import { asyncAppendJsonl } from "../utils/jsonl-emitter.js";
import { childLogger } from "../utils/logger.js";
import type { DecisionJournal } from "../memory/decision-journal.js";
import type {
  BotProgressEvent,
  DecisionJournalEntry,
  Position,
} from "../types/index.js";

const log = childLogger("telegram");

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  commandsFile: string;
  dryRun: boolean;
  dashboardUrl?: string;
  journal?: DecisionJournal;
  positionsFile?: string;
  fetchFn?: typeof fetch;
  pollMs?: number;
}

interface TelegramButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface TelegramReplyMarkup {
  inline_keyboard: TelegramButton[][];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number | string; username?: string };
    message?: {
      message_id: number;
      chat: { id: number | string };
    };
  };
}

interface TelegramMessageResult {
  message_id: number;
}

type TelegramApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; description?: string };

type TelegramCallbackAction =
  | { kind: "screen" }
  | { kind: "manage" }
  | { kind: "decisions" }
  | { kind: "positions" }
  | { kind: "pool"; poolAddress: string }
  | { kind: "help" }
  | { kind: "unknown" };

const DEFAULT_POLL_MS = 2500;
const TELEGRAM_TEXT_LIMIT = 3900;

export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly commandsFile: string;
  private readonly dryRun: boolean;
  private readonly dashboardUrl?: string;
  private readonly journal?: DecisionJournal;
  private readonly positionsFile?: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollMs: number;
  private readonly apiBase: string;

  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private offset = 0;
  private readonly progressMessages = new Map<string, number>();
  private readonly progressMilestones = new Map<string, Set<number>>();

  constructor(opts: TelegramNotifierOptions) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.commandsFile = path.resolve(opts.commandsFile);
    this.dryRun = opts.dryRun;
    this.dashboardUrl = opts.dashboardUrl;
    this.journal = opts.journal;
    this.positionsFile = opts.positionsFile
      ? path.resolve(opts.positionsFile)
      : undefined;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
    this.ensureCommandsFile();
  }

  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollUpdates();
    }, this.pollMs);
    void this.pollUpdates();
    log.info({ pollMs: this.pollMs }, "telegram callback polling started");
  }

  stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log.info("telegram callback polling stopped");
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async sendControlCenter(): Promise<void> {
    await this.sendMessage(
      [
        "<b>Meteora DLMM Control Center</b>",
        `Mode: <code>${this.dryRun ? "DRY-RUN" : "LIVE"}</code>`,
        "Use the buttons below to queue bot cycles or inspect recent memory.",
      ].join("\n"),
      { replyMarkup: this.defaultKeyboard() },
    );
  }

  notifyJournalEntry(entry: DecisionJournalEntry): void {
    if (!shouldNotify(entry)) return;
    this.enqueue(async () => {
      await this.sendMessage(formatJournalEntry(entry), {
        replyMarkup: this.journalKeyboard(entry),
      });
    });
  }

  notifyProgress(event: BotProgressEvent): void {
    const milestone = progressMilestone(event);
    if (!shouldNotifyProgress(event, milestone, this.progressMilestones)) {
      return;
    }
    this.enqueue(async () => {
      await this.upsertProgressMessage(event);
    });
  }

  private async pollUpdates(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const params = new URLSearchParams({
        timeout: "0",
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      });
      if (this.offset > 0) params.set("offset", String(this.offset));
      const data = await this.request<TelegramUpdate[]>(
        "getUpdates",
        undefined,
        params,
      );
      if (!data?.ok) return;
      for (const update of data.result) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        await this.handleUpdate(update);
      }
    } catch (err) {
      log.warn({ err: errMessage(err) }, "telegram polling failed");
    } finally {
      this.polling = false;
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg?.text || !this.isAllowedChat(msg.chat.id)) return;
    await this.handleTextCommand(msg.text);
  }

  private async handleCallback(
    callback: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<void> {
    const chatId = callback.message?.chat.id;
    if (!this.isAllowedChat(chatId)) {
      await this.answerCallback(callback.id, "Unauthorized chat.");
      return;
    }

    const action = parseTelegramCallback(callback.data);
    switch (action.kind) {
      case "screen":
        this.appendCommand("screen", { limit: 50 });
        await this.answerCallback(callback.id, "Screen command queued.");
        await this.sendMessage("Screen command queued.", {
          replyMarkup: this.defaultKeyboard(),
        });
        break;
      case "manage":
        this.appendCommand("manage");
        await this.answerCallback(callback.id, "Manager command queued.");
        await this.sendMessage("Manager command queued.", {
          replyMarkup: this.defaultKeyboard(),
        });
        break;
      case "decisions":
        await this.answerCallback(callback.id, "Loading decisions...");
        await this.sendRecentDecisions();
        break;
      case "positions":
        await this.answerCallback(callback.id, "Loading positions...");
        await this.sendPositions();
        break;
      case "pool":
        await this.answerCallback(callback.id, "Loading pool journal...");
        await this.sendPoolDecisions(action.poolAddress);
        break;
      case "help":
        await this.answerCallback(callback.id, "Control center");
        await this.sendControlCenter();
        break;
      case "unknown":
        await this.answerCallback(callback.id, "Unknown action.");
        break;
    }
  }

  private async handleTextCommand(text: string): Promise<void> {
    const command = text.trim().split(/\s+/)[0]?.toLowerCase();
    switch (command) {
      case "/start":
      case "/help":
        await this.sendControlCenter();
        break;
      case "/screen":
        this.appendCommand("screen", { limit: 50 });
        await this.sendMessage("Screen command queued.", {
          replyMarkup: this.defaultKeyboard(),
        });
        break;
      case "/manage":
        this.appendCommand("manage");
        await this.sendMessage("Manager command queued.", {
          replyMarkup: this.defaultKeyboard(),
        });
        break;
      case "/decisions":
        await this.sendRecentDecisions();
        break;
      case "/positions":
      case "/status":
        await this.sendPositions();
        break;
      default:
        await this.sendMessage("Unknown command. Try /help.", {
          replyMarkup: this.defaultKeyboard(),
        });
    }
  }

  private async sendRecentDecisions(): Promise<void> {
    const entries = this.journal?.recent(6) ?? [];
    if (entries.length === 0) {
      await this.sendMessage("No decision journal entries yet.", {
        replyMarkup: this.defaultKeyboard(),
      });
      return;
    }
    await this.sendMessage(formatDecisionList("Recent Decisions", entries), {
      replyMarkup: this.defaultKeyboard(),
    });
  }

  private async sendPoolDecisions(poolAddress: string): Promise<void> {
    const entries =
      this.journal?.getRecentDecisions({ poolAddress, limit: 6 }) ?? [];
    if (entries.length === 0) {
      await this.sendMessage(
        `No journal entries for <code>${h(poolAddress)}</code>.`,
        {
          replyMarkup: this.defaultKeyboard(),
        },
      );
      return;
    }
    await this.sendMessage(formatDecisionList("Pool Journal", entries), {
      replyMarkup: this.defaultKeyboard(),
    });
  }

  private async sendPositions(): Promise<void> {
    const positions = this.readPositions();
    if (positions.length === 0) {
      await this.sendMessage("No open positions in tracker.", {
        replyMarkup: this.defaultKeyboard(),
      });
      return;
    }
    const total = positions.reduce((sum, pos) => sum + pos.entryValueUsd, 0);
    const lines = [
      "<b>Open Positions</b>",
      `Count: <code>${positions.length}</code> | Entry value: <code>${formatUsd(total)}</code>`,
      "",
      ...positions
        .slice(0, 8)
        .map((pos, i) =>
          [
            `<b>${i + 1}. ${h(pos.poolName)}</b>`,
            `Size: <code>${formatUsd(pos.entryValueUsd)}</code> | Range: <code>${pos.lowerBinId}-${pos.upperBinId}</code>`,
            `Position: <code>${short(pos.positionPubkey)}</code>`,
          ].join("\n"),
        ),
    ];
    await this.sendMessage(lines.join("\n\n"), {
      replyMarkup: this.defaultKeyboard(),
    });
  }

  private readPositions(): Position[] {
    if (!this.positionsFile) return [];
    try {
      const raw = fs.readFileSync(this.positionsFile, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as Position[]) : [];
    } catch (err) {
      log.warn(
        { err: errMessage(err), file: this.positionsFile },
        "failed to read positions for telegram",
      );
      return [];
    }
  }

  private defaultKeyboard(): TelegramReplyMarkup {
    const rows: TelegramButton[][] = [
      [
        { text: "Run Screen", callback_data: "cmd:screen" },
        { text: "Run Manager", callback_data: "cmd:manage" },
      ],
      [
        { text: "Recent Decisions", callback_data: "report:decisions" },
        { text: "Positions", callback_data: "report:positions" },
      ],
    ];
    if (this.dashboardUrl) {
      rows.push([{ text: "Open Dashboard", url: this.dashboardUrl }]);
    }
    return { inline_keyboard: rows };
  }

  private journalKeyboard(entry: DecisionJournalEntry): TelegramReplyMarkup {
    const rows = this.defaultKeyboard().inline_keyboard;
    if (entry.subject.poolAddress) {
      rows.unshift([
        {
          text: "Pool Journal",
          callback_data: `pool:${entry.subject.poolAddress}`,
        },
      ]);
    }
    return { inline_keyboard: rows };
  }

  private appendCommand(
    kind: "screen" | "manage",
    args?: Record<string, unknown>,
  ): void {
    const command = {
      ts: Date.now(),
      id: `tg-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      kind,
      source: "telegram",
      ...(args ? { args } : {}),
    };
    try {
      this.ensureCommandsFile();
      asyncAppendJsonl(this.commandsFile, command);
      log.info({ id: command.id, kind }, "telegram command queued");
    } catch (err) {
      log.warn(
        { err: errMessage(err), kind, file: this.commandsFile },
        "failed to queue telegram command",
      );
    }
  }

  private ensureCommandsFile(): void {
    const dir = path.dirname(this.commandsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.commandsFile))
      fs.writeFileSync(this.commandsFile, "");
  }

  private async sendMessage(
    text: string,
    opts: { replyMarkup?: TelegramReplyMarkup } = {},
  ): Promise<TelegramApiResult<TelegramMessageResult> | null> {
    return this.request<TelegramMessageResult>("sendMessage", {
      chat_id: this.chatId,
      text: text.slice(0, TELEGRAM_TEXT_LIMIT),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
  }

  private async editMessage(
    messageId: number,
    text: string,
    opts: { replyMarkup?: TelegramReplyMarkup } = {},
  ): Promise<TelegramApiResult<true> | null> {
    const result = await this.request<true>("editMessageText", {
      chat_id: this.chatId,
      message_id: messageId,
      text: text.slice(0, TELEGRAM_TEXT_LIMIT),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
    // Treat "message is not modified" as success — content already correct.
    if (
      result &&
      !result.ok &&
      "description" in result &&
      typeof result.description === "string" &&
      result.description.includes("message is not modified")
    ) {
      return { ok: true, result: true } as TelegramApiResult<true>;
    }
    return result;
  }

  private async answerCallback(
    callbackQueryId: string,
    text: string,
  ): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  private async request<T>(
    method: string,
    body?: Record<string, unknown>,
    query?: URLSearchParams,
  ): Promise<TelegramApiResult<T> | null> {
    const url = `${this.apiBase}/${method}${query ? `?${query.toString()}` : ""}`;
    try {
      const res = await this.fetchFn(url, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = (await res.json()) as TelegramApiResult<T>;
      if (!res.ok || !parsed.ok) {
        log.warn(
          {
            method,
            status: res.status,
            description: "description" in parsed ? parsed.description : "",
          },
          "telegram api returned non-ok",
        );
      }
      return parsed;
    } catch (err) {
      log.warn({ err: errMessage(err), method }, "telegram api request failed");
      return null;
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue
      .catch(() => undefined)
      .then(fn)
      .catch((err) => {
        log.warn({ err: errMessage(err) }, "telegram notification failed");
      });
  }

  private isAllowedChat(chatId: number | string | undefined): boolean {
    return String(chatId ?? "") === this.chatId;
  }

  private async upsertProgressMessage(event: BotProgressEvent): Promise<void> {
    const text = formatProgressEvent(event);
    const messageId = this.progressMessages.get(event.cycleId);
    if (messageId) {
      const edited = await this.editMessage(messageId, text, {
        replyMarkup: this.defaultKeyboard(),
      });
      if (edited?.ok) return;
    }
    const sent = await this.sendMessage(text, {
      replyMarkup: this.defaultKeyboard(),
    });
    if (sent?.ok && typeof sent.result.message_id === "number") {
      this.progressMessages.set(event.cycleId, sent.result.message_id);
    }
  }
}

export function parseTelegramCallback(
  data: string | undefined,
): TelegramCallbackAction {
  if (data === "cmd:screen") return { kind: "screen" };
  if (data === "cmd:manage") return { kind: "manage" };
  if (data === "report:decisions") return { kind: "decisions" };
  if (data === "report:positions") return { kind: "positions" };
  if (data === "help") return { kind: "help" };
  if (data?.startsWith("pool:")) {
    const poolAddress = data.slice("pool:".length).trim();
    return poolAddress ? { kind: "pool", poolAddress } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

function shouldNotifyProgress(
  event: BotProgressEvent,
  milestone: number,
  seen: Map<string, Set<number>>,
): boolean {
  if (event.status === "failed" || event.status === "success") return true;
  if (event.source !== "SCREENER" && event.source !== "MANAGER") return false;
  const current = seen.get(event.cycleId) ?? new Set<number>();
  if (current.has(milestone)) return false;
  current.add(milestone);
  seen.set(event.cycleId, current);
  return true;
}

function progressMilestone(event: BotProgressEvent): number {
  if (event.status === "success") return 100;
  if (event.status === "failed") return -1;
  if (event.percent >= 90) return 90;
  if (event.percent >= 75) return 75;
  if (event.percent >= 50) return 50;
  if (event.percent >= 25) return 25;
  return 0;
}

function formatProgressEvent(event: BotProgressEvent): string {
  const subject = event.poolName ?? event.positionPubkey ?? event.phase;
  const lines = [
    `<b>${h(event.source)} Progress</b>`,
    `Status: <code>${h(event.status.toUpperCase())}</code> | Cycle: <code>${h(short(event.cycleId))}</code>`,
    `Progress: <code>${event.percent.toFixed(0)}%</code> ${h(progressBar(event.percent))}`,
    `Phase: <code>${h(event.phase)}</code>`,
    h(event.message),
  ];
  if (subject) lines.push(`Subject: <code>${h(short(subject))}</code>`);
  if (
    typeof event.current === "number" &&
    typeof event.total === "number" &&
    event.total > 0
  ) {
    lines.push(`Items: <code>${event.current}/${event.total}</code>`);
  }
  if (typeof event.etaMs === "number" && event.status === "running") {
    lines.push(`ETA: <code>${h(formatDuration(event.etaMs))}</code>`);
  }
  if (event.detail) {
    lines.push("", `<b>Detail</b>`, h(event.detail.slice(0, 500)));
  }
  return lines.join("\n");
}

function progressBar(percent: number): string {
  const width = 12;
  const filled = Math.max(
    0,
    Math.min(width, Math.round((percent / 100) * width)),
  );
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function shouldNotify(entry: DecisionJournalEntry): boolean {
  if (entry.actor === "EXECUTOR") return true;
  if (entry.actor === "LEARNING") return true;
  if (entry.event === "ACTION_FAILED" || entry.event === "OPEN_FAILED") {
    return true;
  }
  if (entry.event === "OPEN_SUCCESS") return true;
  if (entry.event === "SCREEN_DECISION") return false;
  if (entry.event === "MANAGER_DECISION") {
    return entry.action !== undefined && entry.action !== "HOLD";
  }
  if (entry.event === "ACTION_SUCCESS") {
    return entry.action !== undefined && entry.action !== "HOLD";
  }
  return false;
}

export function formatJournalEntry(entry: DecisionJournalEntry): string {
  const title = `${displayJournalAction(entry)} / ${entry.actor}`;
  const subject =
    entry.subject.poolName ??
    entry.subject.poolAddress ??
    entry.subject.positionPubkey ??
    "unknown subject";
  const lines = [
    `<b>${h(title)}</b>`,
    `Status: <code>${h(entry.status)}</code> | Mode: <code>${entry.dryRun ? "DRY-RUN" : "LIVE"}</code>`,
    `Pool: <code>${h(subject)}</code>`,
    `Journal: <code>${h(entry.id)}</code>`,
    "",
    h(entry.summary),
  ];
  const reasons = entry.reasons.slice(0, 3);
  if (reasons.length > 0) {
    lines.push(
      "",
      "<b>Reasons</b>",
      ...reasons.map((reason) => `- ${h(reason)}`),
    );
  }
  const risks = entry.risks.slice(0, 2);
  if (risks.length > 0) {
    lines.push("", "<b>Risks</b>", ...risks.map((risk) => `- ${h(risk)}`));
  }
  const metrics = compactMetrics(entry.metrics);
  if (metrics.length > 0) {
    lines.push("", `<b>Metrics</b> ${h(metrics.join(" | "))}`);
  }
  return lines.join("\n");
}

function displayJournalAction(entry: DecisionJournalEntry): string {
  if (
    entry.event === "SCREEN_DECISION" &&
    entry.action &&
    ["ENTER", "WATCH", "SKIP"].includes(entry.action)
  ) {
    return `LLM_${entry.action}`;
  }
  return entry.action ?? entry.event;
}

function formatDecisionList(
  title: string,
  entries: DecisionJournalEntry[],
): string {
  const lines = [`<b>${h(title)}</b>`];
  for (const entry of entries) {
    const subject =
      entry.subject.poolName ??
      entry.subject.poolAddress ??
      entry.subject.positionPubkey ??
      "unknown";
    lines.push(
      "",
      `<b>${h(displayJournalAction(entry))}</b> ${h(subject)}`,
      `<code>${h(entry.actor)}</code> / <code>${h(entry.status)}</code> / <code>${entry.dryRun ? "DRY-RUN" : "LIVE"}</code>`,
      h(entry.summary),
      `<code>${h(entry.id)}</code>`,
    );
  }
  return lines.join("\n");
}

function compactMetrics(
  metrics: Record<string, string | number | boolean | null>,
): string[] {
  const preferred = [
    "llmConfidence",
    "confidence",
    "tvlUsd",
    "volume24hUsd",
    "feeActiveTvlRatio",
    "sizeUsd",
    "rangeBps",
    "entryValueUsd",
    "pnlUsd",
    "pnlPct",
    "feesUsd",
    "sampleSize",
  ];
  return preferred
    .flatMap((key) =>
      Object.prototype.hasOwnProperty.call(metrics, key)
        ? [`${key}=${formatMetricValue(metrics[key] ?? null)}`]
        : [],
    )
    .slice(0, 5);
}

function formatMetricValue(value: string | number | boolean | null): string {
  if (value === null) return "n/a";
  if (typeof value === "number") {
    if (Math.abs(value) >= 1000) return formatUsd(value);
    return Number.isInteger(value) ? value.toString() : value.toFixed(4);
  }
  return String(value);
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000)
    return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function short(value: string): string {
  return value.length <= 12
    ? value
    : `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function h(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
