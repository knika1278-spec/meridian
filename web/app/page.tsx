"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useLiveData } from "@/lib/use-live-data";
import type { DashboardSnapshot } from "@/lib/dashboard";
import { cn } from "@/lib/cn";
import {
  Badge,
  Card,
  EmptyState,
  LiveControls,
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

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function OverviewPage() {
  const { data, error, lastUpdated, live, setLive, reload } =
    useLiveData<DashboardSnapshot>("/api/dashboard");

  const o = data?.overview;
  const positions = data?.positions;
  const screening = data?.screening;

  const portfolio = useMemo(() => {
    if (!positions) return null;
    const openValue = positions.open.reduce((a, x) => a + (x.sizeUsd ?? 0), 0);
    const unrealizedPnl = positions.open.reduce(
      (a, x) => a + (x.pnlUsd ?? 0),
      0,
    );
    const realizedPnl = positions.closed.reduce(
      (a, x) => a + (x.pnlUsd ?? 0),
      0,
    );
    const closedWithOutcome = positions.closed.filter(
      (x) => x.pnlUsd !== undefined && x.pnlUsd !== null,
    );
    const wins = closedWithOutcome.filter((x) => (x.pnlUsd ?? 0) > 0).length;
    const winRate =
      closedWithOutcome.length > 0
        ? (wins / closedWithOutcome.length) * 100
        : null;
    return {
      openValue,
      unrealizedPnl,
      realizedPnl,
      totalPnl: unrealizedPnl + realizedPnl,
      winRate,
      openCount: positions.open.length,
      closedCount: positions.closed.length,
    };
  }, [positions]);

  const todayActivity = useMemo(() => {
    if (!data) return null;
    const today = startOfToday();
    const journalToday = o?.recentJournal.filter((j) => j.ts >= today) ?? [];
    const llmToday = screening?.llmRuns.filter((r) => r.ts >= today) ?? [];
    const tradesToday = journalToday.filter(
      (j) =>
        j.action === "ENTER" ||
        j.action === "CLOSE" ||
        j.action === "REBALANCE",
    ).length;
    return {
      tradesToday,
      decisionsToday: llmToday.length,
      journalCount: journalToday.length,
      totalCostToday: llmToday.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    };
  }, [data, o, screening]);

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <h1 className="text-xl m-0 font-bold tracking-tight">Overview</h1>
        <div className="flex-1" />
        {data && (
          <Badge
            text={data.dryRun === false ? "LIVE" : "DRY-RUN"}
            tone={data.dryRun === false ? "#f87171" : "#34d399"}
          />
        )}
        <LiveControls
          live={live}
          setLive={setLive}
          reload={reload}
          lastUpdated={lastUpdated}
          error={error}
        />
      </header>

      {!o ? (
        <EmptyState>
          {error ? `Could not load: ${error}` : "Loading..."}
        </EmptyState>
      ) : (
        <>
          {portfolio && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-[18px]">
              <StatCard
                label="Open value"
                value={fmtUsd(portfolio.openValue)}
                accent="#60a5fa"
              />
              <StatCard
                label="Unrealized PnL"
                value={fmtUsd(portfolio.unrealizedPnl)}
                accent={portfolio.unrealizedPnl >= 0 ? "#34d399" : "#f87171"}
              />
              <StatCard
                label="Realized PnL"
                value={fmtUsd(portfolio.realizedPnl)}
                accent={portfolio.realizedPnl >= 0 ? "#34d399" : "#f87171"}
              />
              <StatCard
                label="Total PnL"
                value={fmtUsd(portfolio.totalPnl)}
                accent={portfolio.totalPnl >= 0 ? "#34d399" : "#f87171"}
              />
              <StatCard
                label="Win rate"
                value={
                  portfolio.winRate !== null ? fmtPct(portfolio.winRate) : "—"
                }
                accent={
                  portfolio.winRate !== null && portfolio.winRate >= 50
                    ? "#34d399"
                    : "#f87171"
                }
                sub={`${portfolio.closedCount} closed`}
              />
            </div>
          )}

          {positions && positions.open.length > 0 && (
            <Card
              title="Active positions"
              right={
                <Link
                  className={cn(
                    "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
                    "rounded-lg px-3.5 py-[7px] cursor-pointer text-[13px] font-medium",
                    "transition-all duration-150 ease-[var(--ease-out)]",
                    "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]",
                  )}
                  href="/positions"
                >
                  All positions →
                </Link>
              }
              span={2}
            >
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
                {positions.open.map((p) => (
                  <div
                    className={cn(
                      "bg-[var(--panel-2)] border border-[var(--border)] rounded-xl",
                      "p-3.5 px-4",
                      "transition-all duration-250 ease-[var(--ease-out)]",
                      "hover:border-[var(--border-hover)] hover:shadow-md-dark hover:-translate-y-px",
                    )}
                    key={p.positionPubkey}
                  >
                    <div className="flex items-center justify-between mb-2.5 text-[13px] font-semibold">
                      <Truncate
                        text={p.poolName ?? p.tokens.join("/")}
                        max={20}
                      />
                      {p.status && <Badge text={p.status} tone="#60a5fa" />}
                    </div>
                    <div className="flex gap-3.5">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-2xs uppercase text-[var(--muted)] font-semibold">
                          PnL
                        </span>
                        <span
                          className={cn(
                            "text-[13px] font-bold tabular-nums",
                            (p.pnlUsd ?? 0) >= 0
                              ? "text-positive"
                              : "text-negative",
                          )}
                        >
                          {fmtUsd(p.pnlUsd)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-2xs uppercase text-[var(--muted)] font-semibold">
                          In-range
                        </span>
                        <span className="text-[13px] font-bold tabular-nums">
                          {fmtPct(p.inRangePct)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-2xs uppercase text-[var(--muted)] font-semibold">
                          Size
                        </span>
                        <span className="text-[13px] font-bold tabular-nums">
                          {fmtUsd(p.sizeUsd)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {todayActivity && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mt-4">
              <StatCard
                label="Trades today"
                value={todayActivity.tradesToday}
                accent="#a78bfa"
              />
              <StatCard
                label="Decisions today"
                value={todayActivity.decisionsToday}
              />
              <StatCard
                label="LLM cost today"
                value={fmtUsd(todayActivity.totalCostToday)}
              />
              <StatCard
                label="Journal entries today"
                value={todayActivity.journalCount}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3.5 mt-4">
            <Card
              title="Decision mix"
              right={
                <Link
                  className={cn(
                    "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
                    "rounded-lg px-3.5 py-[7px] cursor-pointer text-[13px] font-medium",
                    "transition-all duration-150 ease-[var(--ease-out)]",
                    "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]",
                  )}
                  href="/screening"
                >
                  Screening →
                </Link>
              }
            >
              {Object.keys(o.decisionCounts).length === 0 ? (
                <EmptyState>No decisions recorded yet.</EmptyState>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  {Object.entries(o.decisionCounts).map(([action, count]) => (
                    <div
                      className={cn(
                        "bg-[var(--panel-2)] border border-[var(--border)] rounded-10",
                        "px-3 py-2 min-w-[68px]",
                        "transition-border-color duration-150 ease-[var(--ease-out)]",
                        "hover:border-[var(--border-hover)]",
                      )}
                      key={action}
                    >
                      <div className="text-lg font-bold leading-[1.1] tracking-tight tabular-nums">
                        {count}
                      </div>
                      <div className="text-2xs uppercase text-[var(--muted)] font-semibold">
                        {action}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {o.lastCycle && (
                <div className="text-xs text-[var(--muted)] font-medium mt-3.5">
                  Last cycle{" "}
                  <span className="font-mono text-xs font-medium">
                    {o.lastCycle.id}
                  </span>{" "}
                  &middot; {o.lastCycle.passed}/{o.lastCycle.total} passed{" "}
                  &middot; {fmtRel(o.lastCycle.ts)}
                </div>
              )}
            </Card>

            <Card
              title="Recent activity"
              right={
                <Link
                  className={cn(
                    "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
                    "rounded-lg px-3.5 py-[7px] cursor-pointer text-[13px] font-medium",
                    "transition-all duration-150 ease-[var(--ease-out)]",
                    "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]",
                  )}
                  href="/management"
                >
                  Management →
                </Link>
              }
            >
              {o.recentJournal.length === 0 ? (
                <EmptyState>No journal entries yet.</EmptyState>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto">
                  {o.recentJournal.map((j) => (
                    <div
                      className={cn(
                        "flex gap-2.5 items-baseline text-[12.5px] py-2",
                        "border-b border-b-[rgba(30,30,46,0.4)]",
                        "last:border-b-0",
                        "transition-colors duration-150 ease-[var(--ease-out)]",
                      )}
                      key={j.id}
                    >
                      <span className="text-[var(--muted)] text-[11px] whitespace-nowrap min-w-16 font-medium">
                        {fmtRel(j.ts)}
                      </span>
                      <Badge text={j.action ?? j.event} />
                      <span className="flex-1 min-w-0">
                        {j.poolName ? <strong>{j.poolName} </strong> : null}
                        {j.summary}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {data.warnings.length > 0 && (
            <div
              className={cn(
                "mt-4 text-xs text-warning font-medium",
                "bg-warning-glow border border-[rgba(251,191,36,0.2)]",
                "rounded-xl px-4 py-3",
              )}
            >
              {data.warnings.map((w, i) => (
                <div key={i}>&#x26A0; {w}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
