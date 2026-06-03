"use client";

import Link from "next/link";
import { useLiveData } from "@/lib/use-live-data";
import type { DashboardSnapshot } from "@/lib/dashboard";
import { cn } from "@/lib/cn";
import {
  Badge,
  Card,
  EmptyState,
  LiveControls,
  ProgressBar,
  StatCard,
  Truncate,
  fmtPct,
  fmtRel,
  fmtUsd,
} from "@/components/ui";

function pnlClass(v?: number | null): string {
  if (v === undefined || v === null) return "text-right tabular-nums";
  return v >= 0
    ? "text-right tabular-nums text-positive"
    : "text-right tabular-nums text-negative";
}

function stopLossPct(pnlPct?: number | null): number | null {
  if (pnlPct === undefined || pnlPct === null) return null;
  return Math.max(0, ((pnlPct + 15) / 15) * 100);
}

function stopLossColor(pnlPct?: number | null): string {
  const dist = stopLossPct(pnlPct);
  if (dist === null) return "var(--muted)";
  if (dist <= 20) return "#f87171";
  if (dist <= 50) return "#fbbf24";
  return "#34d399";
}

export default function PositionsPage() {
  const { data, error, lastUpdated, live, setLive, reload } =
    useLiveData<DashboardSnapshot>("/api/dashboard");

  const p = data?.positions;
  const openPnl = p?.open.reduce((a, x) => a + (x.pnlUsd ?? 0), 0) ?? 0;
  const closedPnl = p?.closed.reduce((a, x) => a + (x.pnlUsd ?? 0), 0) ?? 0;
  const totalFees =
    p?.open.reduce((a, x) => a + (x.claimableFeesUsd ?? 0), 0) ?? 0;

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <h1 className="text-xl m-0 font-bold tracking-tight">Positions</h1>
        <div className="flex-1" />
        <LiveControls
          live={live}
          setLive={setLive}
          reload={reload}
          lastUpdated={lastUpdated}
          error={error}
        />
      </header>

      {!p ? (
        <EmptyState>
          {error ? `Could not load: ${error}` : "Loading…"}
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-[18px]">
            <StatCard label="Open" value={p.open.length} accent="#60a5fa" />
            <StatCard label="Closed" value={p.closed.length} />
            <StatCard
              label="Unrealized PnL"
              value={fmtUsd(openPnl)}
              accent={openPnl >= 0 ? "#34d399" : "#f87171"}
            />
            <StatCard
              label="Realized PnL"
              value={fmtUsd(closedPnl)}
              accent={closedPnl >= 0 ? "#34d399" : "#f87171"}
            />
            <StatCard
              label="Claimable Fees"
              value={fmtUsd(totalFees)}
              accent="#a78bfa"
            />
          </div>

          <Card title="Open positions">
            {p.open.length === 0 ? (
              <EmptyState>No open positions.</EmptyState>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Pool
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Age
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Size
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        PnL
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Fees
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Range
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Stop-loss
                      </th>
                      <th className="px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]" />
                    </tr>
                  </thead>
                  <tbody>
                    {p.open.map((x) => {
                      const slDist = stopLossPct(x.pnlPct);
                      return (
                        <tr
                          key={x.positionPubkey}
                          className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
                        >
                          <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                            <Truncate
                              text={x.poolName ?? x.tokens.join("/")}
                              max={22}
                            />
                          </td>
                          <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-[var(--muted)] text-xs">
                            {x.ageMinutes != null
                              ? x.ageMinutes < 60
                                ? `${Math.round(x.ageMinutes)}m`
                                : `${(x.ageMinutes / 60).toFixed(1)}h`
                              : fmtRel(x.openedAt)}
                          </td>
                          <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                            {fmtUsd(x.sizeUsd)}
                          </td>
                          <td className={cn("px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top", pnlClass(x.pnlUsd))}>
                            <span>{fmtUsd(x.pnlUsd)}</span>
                            {x.pnlPct != null && (
                              <span className="text-[11px] ml-1 opacity-70">
                                ({fmtPct(x.pnlPct)})
                              </span>
                            )}
                          </td>
                          <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums text-cycle">
                            {fmtUsd(x.claimableFeesUsd)}
                          </td>
                          <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top min-w-[100px]">
                            <ProgressBar
                              value={x.inRangePct ?? 0}
                              color={
                                (x.inRangePct ?? 0) >= 70
                                  ? "#34d399"
                                  : (x.inRangePct ?? 0) >= 40
                                    ? "#fbbf24"
                                    : "#f87171"
                              }
                              sub={fmtPct(x.inRangePct)}
                            />
                          </td>
                          <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                            {slDist !== null ? (
                              <span
                                className="text-xs font-semibold"
                                style={{ color: stopLossColor(x.pnlPct) }}
                              >
                                {slDist <= 0
                                  ? "TRIGGERED"
                                  : `${(100 - slDist).toFixed(0)}% to SL`}
                              </span>
                            ) : (
                              <span className="text-[var(--muted)]">—</span>
                            )}
                          </td>
                          <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                            <Link
                              className={cn(
                                "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
                                "rounded-lg px-2 py-[3px] cursor-pointer text-[11px] font-medium",
                                "transition-all duration-150 ease-[var(--ease-out)]",
                                "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
                              )}
                              href={`/positions/${x.positionPubkey}`}
                            >
                              Detail
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="h-4" />

          <Card title="Closed positions">
            {p.closed.length === 0 ? (
              <EmptyState>No closed positions yet.</EmptyState>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Pool
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Closed
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Exit reason
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        PnL
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.closed.map((x) => (
                      <tr
                        key={x.positionPubkey}
                        className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
                      >
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          <Truncate
                            text={x.poolName ?? x.positionPubkey}
                            max={22}
                          />
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {fmtRel(x.closedAt)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {x.exitReason ? (
                            <Badge text={x.exitReason} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={cn("px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top", pnlClass(x.pnlUsd))}>
                          {fmtUsd(x.pnlUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
