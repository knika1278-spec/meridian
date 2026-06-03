"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function fmtTime(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function fmtRel(ts?: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtUsd(v?: number | null): string {
  if (v === undefined || v === null) return "—";
  return v.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: v >= 100 ? 0 : 4,
  });
}

export function fmtNum(v?: number | null, digits = 0): string {
  if (v === undefined || v === null) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtPct(v?: number | null, digits = 1): string {
  if (v === undefined || v === null) return "—";
  return `${v.toFixed(digits)}%`;
}

const ACTION_TONE: Record<string, string> = {
  ENTER: "#34d399",
  WATCH: "#fbbf24",
  SKIP: "#f87171",
  HOLD: "#60a5fa",
  CLAIM: "#a78bfa",
  CLOSE: "#f472b6",
  REBALANCE: "#22d3ee",
  SUCCESS: "#34d399",
  FAILED: "#f87171",
  SKIPPED: "#6b7094",
  PROPOSED: "#fbbf24",
  INFO: "#60a5fa",
};

export function Badge({ text, tone }: { text: string; tone?: string }) {
  const color = tone ?? ACTION_TONE[text] ?? "#6b7094";
  return (
    <span
      className="inline-block px-2.5 rounded-full text-[11px] font-semibold whitespace-nowrap tracking-wide"
      style={{
        color,
        background: color + "1a",
        border: `1px solid ${color}22`,
        textShadow: `0 0 12px ${color}40`,
      }}
    >
      {text}
    </span>
  );
}

export function Card({
  title,
  right,
  children,
  span,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  span?: number;
}) {
  return (
    <section
      className={cn(
        "bg-[var(--glass-bg)] backdrop-blur-xl border border-[var(--glass-border)]",
        "rounded-14 p-[18px_20px] min-w-0",
        "transition-all duration-250 ease-[var(--ease-out)]",
        "shadow-sm-dark",
        "hover:border-[var(--border-hover)] hover:shadow-md-dark"
      )}
      style={span ? { gridColumn: `span ${span}` } : undefined}
    >
      {(title || right) && (
        <div className="flex items-center mb-3.5">
          {title && (
            <h2 className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)] m-0 font-bold">
              {title}
            </h2>
          )}
          <div className="flex-1" />
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  sub?: string;
}) {
  return (
    <div
      className={cn(
        "bg-[var(--panel)] border border-[var(--border)] rounded-14",
        "p-4 relative overflow-hidden",
        "transition-all duration-250 ease-[var(--ease-out)]",
        "hover:border-[var(--border-hover)] hover:shadow-md-dark hover:-translate-y-px",
        "group"
      )}
    >
      {/* Top accent line on hover */}
      <div
        className="absolute top-0 left-0 right-0 h-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-250"
        style={{
          background: accent
            ? `linear-gradient(90deg, transparent, ${accent}, transparent)`
            : "linear-gradient(90deg, transparent, var(--accent), transparent)",
        }}
      />
      <div
        className="text-[26px] font-extrabold leading-[1.1] tracking-tight"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      <div className="text-2xs uppercase text-[var(--muted)] mt-1 font-semibold">
        {label}
      </div>
      {sub && (
        <div className="text-[11px] text-[var(--muted)] mt-1.5 font-medium">
          {sub}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="text-[var(--muted)] text-[13px] py-8 px-2 text-center leading-relaxed font-medium">
      {children}
    </div>
  );
}

export function LiveControls({
  live,
  setLive,
  reload,
  lastUpdated,
  error,
}: {
  live: boolean;
  setLive: (v: boolean) => void;
  reload: () => void;
  lastUpdated: number | null;
  error: string | null;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-xs text-[var(--muted)] font-medium">
        {error ? (
          <span className="text-negative">error: {error}</span>
        ) : lastUpdated ? (
          <>
            <span className={live ? "text-linked font-semibold" : ""}>
              {live ? "● live" : "○ paused"}
            </span>{" "}
            &middot; {fmtRel(lastUpdated)}
          </>
        ) : (
          "loading…"
        )}
      </span>
      <button
        className={cn(
          "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
          "rounded-lg px-3.5 py-[7px] cursor-pointer text-[13px] font-medium",
          "transition-all duration-150 ease-[var(--ease-out)]",
          "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]",
          live && "border-accent text-accent bg-accent-glow"
        )}
        onClick={() => setLive(!live)}
      >
        {live ? "Pause" : "Resume"}
      </button>
      <button
        className={cn(
          "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
          "rounded-lg px-3.5 py-[7px] cursor-pointer text-[13px] font-medium",
          "transition-all duration-150 ease-[var(--ease-out)]",
          "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
        )}
        onClick={reload}
      >
        Refresh
      </button>
    </div>
  );
}

export function Truncate({ text, max = 16 }: { text: string; max?: number }) {
  if (text.length <= max) return <>{text}</>;
  return <span title={text}>{text.slice(0, max - 1)}&hellip;</span>;
}

/* ---- ProgressBar ---- */
export function ProgressBar({
  value,
  color = "var(--accent)",
  label,
  sub,
}: {
  value: number;
  color?: string;
  label?: string;
  sub?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="w-full">
      {(label || sub) && (
        <div className="flex justify-between items-baseline mb-[5px]">
          {label && (
            <span className="text-xs font-semibold">{label}</span>
          )}
          {sub && (
            <span className="text-[11px] text-[var(--muted)] font-medium">
              {sub}
            </span>
          )}
        </div>
      )}
      <div className="w-full h-1.5 bg-[var(--panel-3)] rounded-[3px] overflow-hidden">
        <div
          className="h-full rounded-[3px] transition-[width] duration-500 ease-[var(--ease-out)]"
          style={{
            width: `${clamped}%`,
            background: `linear-gradient(90deg, ${color}, ${color}cc)`,
            boxShadow: `0 0 10px ${color}30`,
          }}
        />
      </div>
    </div>
  );
}

/* ---- StatusIndicator ---- */
export function StatusIndicator({
  status,
  label,
}: {
  status: "green" | "yellow" | "red";
  label: string;
}) {
  const colors = {
    green: { bg: "#34d399", glow: "rgba(52, 211, 153, 0.3)" },
    yellow: { bg: "#fbbf24", glow: "rgba(251, 191, 36, 0.3)" },
    red: { bg: "#f87171", glow: "rgba(248, 113, 113, 0.3)" },
  };
  const c = colors[status];
  return (
    <span className="inline-flex items-center gap-[7px]">
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 relative after:content-[''] after:absolute after:-inset-[3px] after:rounded-full after:animate-status-pulse"
        style={{
          backgroundColor: c.bg,
          boxShadow: `0 0 8px ${c.glow}`,
          background: c.bg,
        }}
      />
      <span className="text-[12.5px] text-[var(--text-secondary)] font-medium">
        {label}
      </span>
    </span>
  );
}

/* ---- MiniSparkline ---- */
export function MiniSparkline({
  data,
  color = "var(--accent)",
  width = 80,
  height = 24,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const padding = 2;
  const w = width - padding * 2;
  const h = height - padding * 2;
  const points = data
    .map((v, i) => {
      const x = padding + (i / (data.length - 1)) * w;
      const y = padding + h - ((v - min) / range) * h;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="inline-block align-middle"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---- RefreshCountdown ---- */
export function RefreshCountdown({
  seconds,
  label = "Next refresh",
}: {
  seconds: number;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-[5px] text-[11px] text-[var(--muted)] font-medium">
      <span>{label}</span>
      <span className="tabular-nums font-bold text-[var(--text)]">
        {seconds}s
      </span>
    </span>
  );
}

/* ---- MetricChange ---- */
export function MetricChange({
  value,
  previous,
  suffix = "",
}: {
  value: number;
  previous: number;
  suffix?: string;
}) {
  const diff = value - previous;
  const pct = previous !== 0 ? (diff / Math.abs(previous)) * 100 : 0;
  const isUp = diff >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[3px] text-xs font-semibold",
        isUp ? "text-positive" : "text-negative"
      )}
    >
      <span className="text-[9px]">{isUp ? "▲" : "▼"}</span>
      <span className="tabular-nums">
        {fmtPct(pct)}
        {suffix}
      </span>
    </span>
  );
}
