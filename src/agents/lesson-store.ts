import fs from "node:fs";
import path from "node:path";
import type { Lesson } from "../types/index.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("lesson-store");

export interface LessonStoreOptions {
  filePath: string;
  /** Recency decay in days (default 30). */
  lessonRecencyDays?: number;
}

export interface FindRelevantOptions {
  tags?: string[];
  poolName?: string;
  limit: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class LessonStore {
  private readonly filePath: string;
  private readonly lessonRecencyDays: number;
  private lessons: Lesson[];

  constructor(opts: LessonStoreOptions) {
    this.filePath = path.resolve(opts.filePath);
    this.lessonRecencyDays = opts.lessonRecencyDays ?? 30;
    this.ensureFile();
    this.lessons = this.readFromDisk();
  }

  add(lesson: Lesson): Lesson {
    const stored: Lesson = {
      ...lesson,
      id: lesson.id && lesson.id.length > 0 ? lesson.id : generateLessonId(),
    };
    this.lessons.push(stored);
    this.flush();
    return stored;
  }

  list(limit?: number): Lesson[] {
    const sorted = [...this.lessons].sort((a, b) => b.timestamp - a.timestamp);
    if (limit === undefined) return sorted;
    return sorted.slice(0, Math.max(0, limit));
  }

  findRelevant(opts: FindRelevantOptions): Lesson[] {
    const now = Date.now();
    const targetTags = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
    const targetPool = opts.poolName?.toLowerCase();
    const targetTokens = new Set(
      targetPool
        ? targetPool
            .split("-")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    );

    const scored = this.lessons.map((lesson) => {
      let score = 0;

      const lessonTagsLower = lesson.tags.map((t) => t.toLowerCase());
      for (const tag of lessonTagsLower) {
        if (targetTags.has(tag)) score += 3;
      }

      const lessonPoolLower = lesson.poolName.toLowerCase();
      if (targetPool && lessonPoolLower === targetPool) {
        score += 5;
      } else if (targetTokens.size > 0) {
        const lessonTokens = lessonPoolLower
          .split("-")
          .map((s) => s.trim())
          .filter(Boolean);
        const shared = lessonTokens.some((t) => targetTokens.has(t));
        if (shared) score += 2;
      }

      const ageDays = (now - lesson.timestamp) / MS_PER_DAY;
      const recencyBonus = Math.max(0, 1 - ageDays / this.lessonRecencyDays);
      score += recencyBonus;

      return { lesson, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.lesson.timestamp - a.lesson.timestamp;
      })
      .slice(0, Math.max(0, opts.limit))
      .map((s) => s.lesson);
  }

  count(): number {
    return this.lessons.length;
  }

  path(): string {
    return this.filePath;
  }

  private ensureFile(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, "[]", "utf-8");
      }
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to ensure lessons file",
      );
    }
  }

  private readFromDisk(): Lesson[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log.warn({ path: this.filePath }, "lessons file not array, resetting");
        return [];
      }
      return parsed as Lesson[];
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "corrupt or unreadable lessons file, treating as empty",
      );
      return [];
    }
  }

  private flush(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.lessons, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to write lessons file",
      );
    }
  }
}

function generateLessonId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `L-${date}-${rand}`;
}
