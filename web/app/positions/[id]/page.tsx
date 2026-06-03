"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { PositionDetail } from "@/lib/dashboard";
import { cn } from "@/lib/cn";
import {
  Badge,
  Card,
  EmptyState,
  ProgressBar,
  StatCard,
  fmtPct,
  fmtRel,
  fmtTime,
  fmtUsd,
} from "@/components/ui";

function pnlClass(v?: number | null): string {
  if (v === undefined || v === null) return "";
  return v >= 0 ? "text-positive" : "text-negative";
}

function fmtPrice(v?: number | null): string {
  if (v === undefined || v === null) return "—";
  if (v < 0.0001) return v.toExponential(4);
  if (v < 1) return v.toFixed(6);
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function BinVisualization({
  lower,
  upper,
  entry,
  current,
}: {
  lower?: number;
  upper?: number;
  entry?: number;
  current?: number;
}) {
  if (
    lower === undefined ||
    upper === undefined ||
    entry === undefined ||
    current === undefined
  ) {
    return <span className="text-[var(--muted)]">Bin data unavailable</span>;
  }

  const range = upper - lower;
  if (range === 0) return <span className="text-[var(--muted)]">Single bin</span>;

  const entryPct = ((entry - lower) / range) * 100;
  const currentPct = Math.max(0, Math.min(100, ((current - lower) / range) * 100));

  return (
    <div>
      <div className="flex items-center gap-2.5 py-2.5">
        <span className="text-[11px] text-[var(--muted)] whitespace-nowrap min-w-[50px] font-medium">
          {lower}
        </span>
        <div className="flex-1 h-3 bg-[var(--panel-3)] rounded-[6px] relative overflow-visible">
          <div
            className="absolute -top-0.5 w-[3px] h-4 rounded-sm -translate-x-1/2"
            style={{ left: `${entryPct}%`, background: "#60a5fa" }}
            title={`Entry: ${entry}`}
          />
          <div
            className="absolute -top-0.5 w-[3px] h-4 rounded-sm -translate-x-1/2"
            style={{ left: `${currentPct}%`, background: "#f472b6" }}
            title={`Current: ${current}`}
          />
        </div>
        <span className="text-[11px] text-[var(--muted)] whitespace-nowrap min-w-[50px] font-medium">
          {upper}
        </span>
      </div>
      <div className="flex gap-4 text-[11px] text-[var(--muted)]">
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-[#60a5fa] mr-1 align-middle" />
          Entry: {entry}
        </span>
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-[#f472b6] mr-1 align-middle" />
          Current: {current}
        </span>
      </div>
    </div>
  );
}

function RiskBadge({
  label,
  value,
  threshold,
  inverse = false,
}: {
  label: string;
  value?: number | null;
  threshold: number;
  inverse?: boolean;
}) {
  if (value === undefined || value === null) {
    return (
      <span className="inline-flex items-center gap-[5px] px-3 py-1 rounded-lg text-xs font-semibold bg-[var(--panel-2)] text-[var(--muted)]">
        {label}: —
      </span>
    );
  }
  const level = inverse
    ? value > threshold ? "danger" : value > threshold * 0.7 ? "warning" : "safe"
    : value < threshold ? "danger" : value < threshold * 1.3 ? "warning" : "safe";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] px-3 py-1 rounded-lg text-xs font-semibold",
        level === "safe" && "bg-positive-glow text-positive border border-[rgba(52,211,153,0.2)]",
        level === "warning" && "bg-warning-glow text-warning border border-[rgba(251,191,36,0.2)]",
        level === "danger" && "bg-negative-glow text-negative border border-[rgba(248,113,113,0.2)]"
      )}
    >
      {label}: {typeof value === "number" ? value.toFixed(1) : value}
      {typeof value === "number" && label.includes("%") ? "" : "%"}
    </span>
  );
}

export default function PositionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [id, setId] = useState<string | null>(null);
  const [pos, setPos] = useState<PositionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/positions/${id}`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) {
          setError("Position not found");
        } else {
          setError(`HTTP ${res.status}`);
        }
        setPos(null);
        return;
      }
      const json = (await res.json()) as PositionDetail & { error?: string };
      if (json && typeof json === "object" && "error" in json && json.error) {
        setError(json.error);
        setPos(null);
        return;
      }
      setPos(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPos(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const ev = pos?.lastEvaluation;
  const unrealizedPnl = ev?.pnlUsd ?? 0;
  const feesUsd = ev?.claimableFees?.usdValue ?? 0;
  const totalPnl = unrealizedPnl + feesUsd;
  const stopLossDist =
    ev?.pnlPct != null ? Math.max(0, ((ev.pnlPct + 15) / 15) * 100) : null;

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <Link
          href="/positions"
          className={cn(
            "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
            "rounded-lg px-3.5 py-[7px] cursor-pointer text-xs font-medium",
            "transition-all duration-150 ease-[var(--ease-out)]",
            "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
          )}
        >
          &larr; Positions
        </Link>
        <h1 className="text-xl m-0 font-bold tracking-tight">
          {pos?.poolName ?? "Position"}
        </h1>
        <div className="flex-1" />
        {pos && (
          <Badge
            text={ev?.inRange === false ? "OUT OF RANGE" : ev?.inRange === true ? "IN RANGE" : "UNKNOWN"}
            tone={ev?.inRange === false ? "#f87171" : ev?.inRange === true ? "#34d399" : "#8b97ad"}
          />
        )}
        <button
          className={cn(
            "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
            "rounded-lg px-3.5 py-[7px] cursor-pointer text-[13px] font-medium",
            "transition-all duration-150 ease-[var(--ease-out)]",
            "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]",
            loading && "opacity-50 cursor-not-allowed"
          )}
          onClick={load}
          disabled={loading}
        >
          Refresh
        </button>
      </header>

      {error ? (
        <EmptyState>{error}</EmptyState>
      ) : !pos ? (
        <EmptyState>{loading ? "Loading…" : "Position not found"}</EmptyState>
      ) : (
        <>
          {/* Overview stats */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-[18px]">
            <StatCard
              label="Current Value"
              value={fmtUsd(ev?.currentValueUsd ?? pos.entryValueUsd)}
              accent="#60a5fa"
            />
            <StatCard
              label="Entry Value"
              value={fmtUsd(pos.entryValueUsd)}
            />
            <StatCard
              label="Unrealized PnL"
              value={fmtUsd(unrealizedPnl)}
              accent={unrealizedPnl >= 0 ? "#34d399" : "#f87171"}
              sub={ev?.pnlPct != null ? fmtPct(ev.pnlPct * 100) : undefined}
            />
            <StatCard
              label="Claimable Fees"
              value={fmtUsd(feesUsd)}
              accent="#a78bfa"
            />
            <StatCard
              label="Total PnL"
              value={fmtUsd(totalPnl)}
              accent={totalPnl >= 0 ? "#34d399" : "#f87171"}
              sub="unrealized + fees"
            />
          </div>

          <div className="grid grid-cols-2 gap-3.5">
            {/* Price comparison */}
            <Card title="Price">
              <div className="flex gap-5 items-center">
                <div className="text-center">
                  <div className="text-[22px] font-extrabold tabular-nums tracking-tight text-[#60a5fa]">
                    {fmtPrice(pos.entryPrice)}
                  </div>
                  <div className="text-2xs text-[var(--muted)] uppercase font-semibold">
                    Entry
                  </div>
                </div>
                <div className="text-[22px] text-[var(--muted)]">&rarr;</div>
                <div className="text-center">
                  <div
                    className={cn(
                      "text-[22px] font-extrabold tabular-nums tracking-tight",
                      pnlClass(ev?.currentPrice != null && pos.entryPrice != null ? ev.currentPrice - pos.entryPrice : null)
                    )}
                  >
                    {fmtPrice(ev?.currentPrice)}
                  </div>
                  <div className="text-2xs text-[var(--muted)] uppercase font-semibold">
                    Current
                  </div>
                </div>
                {ev?.currentPrice != null && pos.entryPrice != null && pos.entryPrice > 0 && (
                  <div className="ml-2">
                    <Badge
                      text={`${(((ev.currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%`}
                      tone={ev.currentPrice >= pos.entryPrice ? "#34d399" : "#f87171"}
                    />
                  </div>
                )}
              </div>
            </Card>

            {/* Bin range */}
            <Card title="Bin range">
              <BinVisualization
                lower={pos.lowerBinId}
                upper={pos.upperBinId}
                entry={pos.entryActiveBinId}
                current={ev?.currentActiveBinId}
              />
              <div className="grid grid-cols-[140px_1fr] gap-y-[7px] gap-x-3.5 text-[13px] mt-3">
                <span className="text-[var(--muted)] font-medium">Bin step</span>
                <span className="tabular-nums">{pos.binStep ?? "—"}</span>
                <span className="text-[var(--muted)] font-medium">Range width</span>
                <span className="tabular-nums">
                  {pos.lowerBinId != null && pos.upperBinId != null
                    ? `${pos.upperBinId - pos.lowerBinId} bins`
                    : "—"}
                </span>
                <span className="text-[var(--muted)] font-medium">Strategy</span>
                <span>{pos.strategyType ?? "—"}</span>
              </div>
            </Card>

            {/* Risk metrics */}
            <Card title="Risk metrics">
              <div className="flex flex-wrap gap-2 mb-3">
                <RiskBadge
                  label="In-range"
                  value={ev?.inRangePct != null ? ev.inRangePct * 100 : null}
                  threshold={50}
                />
                <RiskBadge
                  label="Stop-loss"
                  value={stopLossDist != null ? 100 - stopLossDist : null}
                  threshold={80}
                  inverse
                />
                {ev?.ilUsd != null && (
                  <span className="inline-flex items-center gap-[5px] px-3 py-1 rounded-lg text-xs font-semibold bg-warning-glow text-warning border border-[rgba(251,191,36,0.2)]">
                    IL: {fmtUsd(ev.ilUsd)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-[140px_1fr] gap-y-[7px] gap-x-3.5 text-[13px]">
                <span className="text-[var(--muted)] font-medium">Out of range</span>
                <span className="tabular-nums">
                  {ev?.outOfRangeMinutes != null
                    ? ev.outOfRangeMinutes < 60
                      ? `${Math.round(ev.outOfRangeMinutes)}m`
                      : `${(ev.outOfRangeMinutes / 60).toFixed(1)}h`
                    : "—"}
                </span>
                <span className="text-[var(--muted)] font-medium">Age</span>
                <span className="tabular-nums">
                  {ev?.ageMinutes != null
                    ? ev.ageMinutes < 60
                      ? `${Math.round(ev.ageMinutes)}m`
                      : `${(ev.ageMinutes / 60).toFixed(1)}h`
                    : "—"}
                </span>
                <span className="text-[var(--muted)] font-medium">Last evaluated</span>
                <span>
                  {ev?.evaluatedAt ? fmtRel(ev.evaluatedAt) : "—"}
                </span>
                <span className="text-[var(--muted)] font-medium">In-range bar</span>
                <span className="min-w-[100px]">
                  <ProgressBar
                    value={(ev?.inRangePct ?? 0) * 100}
                    color={
                      (ev?.inRangePct ?? 0) >= 0.7
                        ? "#34d399"
                        : (ev?.inRangePct ?? 0) >= 0.4
                          ? "#fbbf24"
                          : "#f87171"
                    }
                  />
                </span>
              </div>
            </Card>

            {/* Position details */}
            <Card title="Position info">
              <div className="grid grid-cols-[140px_1fr] gap-y-[7px] gap-x-3.5 text-[13px]">
                <span className="text-[var(--muted)] font-medium">Position ID</span>
                <span className="font-mono text-[11px]">
                  {pos.positionPubkey}
                </span>
                <span className="text-[var(--muted)] font-medium">Pool</span>
                <span>{pos.poolName ?? pos.poolAddress ?? "—"}</span>
                <span className="text-[var(--muted)] font-medium">Tokens</span>
                <span>
                  {pos.tokenX?.symbol ?? "?"} / {pos.tokenY?.symbol ?? "?"}
                </span>
                <span className="text-[var(--muted)] font-medium">Opened</span>
                <span>{fmtTime(pos.entryTimestamp)}</span>
                <span className="text-[var(--muted)] font-medium">Entry value</span>
                <span>{fmtUsd(pos.entryValueUsd)}</span>
                <span className="text-[var(--muted)] font-medium">Dry run</span>
                <span>{pos.dryRun != null ? (pos.dryRun ? "Yes" : "No") : "—"}</span>
                {pos.txSignature && (
                  <>
                    <span className="text-[var(--muted)] font-medium">Tx</span>
                    <span className="font-mono text-[11px]">
                      <a
                        href={`https://solscan.io/tx/${pos.txSignature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent"
                      >
                        {pos.txSignature.slice(0, 16)}…
                      </a>
                    </span>
                  </>
                )}
                {pos.notes && (
                  <>
                    <span className="text-[var(--muted)] font-medium">Notes</span>
                    <span className="text-xs">
                      {pos.notes}
                    </span>
                  </>
                )}
              </div>
            </Card>
          </div>

          {/* Fee breakdown */}
          {ev?.claimableFees && (
            <div className="mt-4">
              <Card title="Fee breakdown">
                <div className="grid grid-cols-[140px_1fr] gap-y-[7px] gap-x-3.5 text-[13px]">
                  <span className="text-[var(--muted)] font-medium">Fee token X</span>
                  <span>{ev.claimableFees.tokenX ?? "0"}</span>
                  <span className="text-[var(--muted)] font-medium">Fee token Y</span>
                  <span>{ev.claimableFees.tokenY ?? "0"}</span>
                  <span className="text-[var(--muted)] font-medium">Fee value (USD)</span>
                  <span className="text-cycle font-semibold">
                    {fmtUsd(ev.claimableFees.usdValue)}
                  </span>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
