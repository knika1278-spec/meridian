"use client";

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
  fmtPct,
  fmtRel,
  fmtUsd,
} from "@/components/ui";

const MONITOR_POLL_MS = 10_000;

function GateDot({ status }: { status: "pass" | "block" | "info" }) {
  return (
    <span
      className={cn(
        "w-2 h-2 rounded-full flex-shrink-0 relative",
        "after:content-[''] after:absolute after:-inset-[3px] after:rounded-full",
        status === "pass" && "bg-positive shadow-glow-positive",
        status === "block" && "bg-negative shadow-glow-negative after:animate-status-pulse",
        status === "info" && "bg-accent shadow-glow-accent after:animate-status-pulse"
      )}
    />
  );
}

export default function MonitorPage() {
  const { data, error, lastUpdated, live, setLive, reload } =
    useLiveData<DashboardSnapshot>("/api/dashboard", MONITOR_POLL_MS);

  const o = data?.overview;
  const screening = data?.screening;
  const management = data?.management;
  const positions = data?.positions;

  const safetyGates = useMemo(() => {
    if (!positions || !data) return [];
    const gates: { label: string; status: "pass" | "block" | "info"; detail: string }[] = [];

    const openCount = positions.open.length;
    gates.push({
      label: "Open positions",
      status: openCount < 10 ? "pass" : "block",
      detail: `${openCount} active`,
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();

    const todayEvents =
      management?.events.filter((e) => e.ts >= todayTs) ?? [];
    const tradesToday = todayEvents.filter(
      (e) =>
        e.action === "ENTER" ||
        e.action === "CLOSE" ||
        e.action === "REBALANCE"
    ).length;
    gates.push({
      label: "Trades today",
      status: tradesToday < 20 ? "pass" : "block",
      detail: `${tradesToday} executed`,
    });

    const unrealizedPnl = positions.open.reduce(
      (a, x) => a + (x.pnlUsd ?? 0),
      0
    );
    gates.push({
      label: "Unrealized PnL",
      status: unrealizedPnl >= 0 ? "pass" : "info",
      detail: fmtUsd(unrealizedPnl),
    });

    const inRangePositions = positions.open.filter(
      (p) => (p.inRangePct ?? 0) >= 80
    ).length;
    const inRangePct =
      openCount > 0 ? (inRangePositions / openCount) * 100 : 100;
    gates.push({
      label: "In-range health",
      status: inRangePct >= 60 ? "pass" : "block",
      detail: `${inRangePositions}/${openCount} healthy`,
    });

    const llmCostToday =
      screening?.llmRuns
        .filter((r) => r.ts >= todayTs)
        .reduce((a, r) => a + (r.costUsd ?? 0), 0) ?? 0;
    gates.push({
      label: "LLM cost today",
      status: llmCostToday < 5 ? "pass" : "info",
      detail: fmtUsd(llmCostToday),
    });

    if (data.dryRun === false) {
      gates.push({
        label: "Mode",
        status: "block",
        detail: "LIVE trading",
      });
    } else {
      gates.push({
        label: "Mode",
        status: "pass",
        detail: "Dry-run (safe)",
      });
    }

    return gates;
  }, [positions, management, screening, data]);

  const deployGates = useMemo(() => {
    if (!management) return [];
    const recentEvents = management.events.slice(0, 20);
    return recentEvents
      .filter(
        (e) =>
          e.action === "ENTER" ||
          e.action === "SKIP" ||
          e.action === "CLOSE" ||
          e.event?.includes("gate") ||
          e.event?.includes("deploy") ||
          e.summary?.toLowerCase().includes("gate") ||
          e.summary?.toLowerCase().includes("deploy") ||
          e.summary?.toLowerCase().includes("blocked") ||
          e.summary?.toLowerCase().includes("passed")
      )
      .slice(0, 8);
  }, [management]);

  const managerCycle = useMemo(() => {
    if (!management) return null;
    const progress = management.progress;
    if (progress.length === 0) return null;
    return progress[0];
  }, [management]);

  const recentDecisions = useMemo(() => {
    if (!screening) return [];
    return screening.llmRuns.slice(0, 10);
  }, [screening]);

  const activityFeed = useMemo(() => {
    if (!o) return [];
    return o.recentJournal.slice(0, 15);
  }, [o]);

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <h1 className="text-xl m-0 font-bold tracking-tight">Live Monitor</h1>
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
          <div className="grid grid-cols-2 gap-3.5">
            <Card title="Screening cycle" span={2}>
              {o.lastCycle ? (
                <div className="flex items-center gap-3 px-3.5 py-3 bg-[var(--panel-2)] border border-[var(--border)] rounded-xl text-[13px]">
                  <span className="w-2.5 h-2.5 rounded-full bg-positive shadow-glow-positive animate-pulse-cycle" />
                  <div>
                    <strong>Cycle {o.lastCycle.id}</strong>
                    <span className="mx-2 text-[var(--muted)]">&middot;</span>
                    {o.lastCycle.passed}/{o.lastCycle.total} passed filters
                    <span className="mx-2 text-[var(--muted)]">&middot;</span>
                    {fmtRel(o.lastCycle.ts)}
                  </div>
                </div>
              ) : (
                <EmptyState>No screening cycles recorded yet.</EmptyState>
              )}
              {screening && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mt-3">
                  <StatCard
                    label="Total LLM calls"
                    value={screening.totals.calls}
                  />
                  <StatCard
                    label="LLM cost"
                    value={fmtUsd(screening.totals.costUsd)}
                  />
                  <StatCard
                    label="Avg latency"
                    value={`${Math.round(screening.totals.avgLatencyMs)}ms`}
                  />
                  <StatCard
                    label="Candidates"
                    value={screening.candidates.length}
                  />
                </div>
              )}
            </Card>

            <Card title="Safety gates">
              {safetyGates.length === 0 ? (
                <EmptyState>No gate data available.</EmptyState>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
                  {safetyGates.map((g) => (
                    <div
                      className={cn(
                        "bg-[var(--panel-2)] border border-[var(--border)] rounded-10",
                        "px-3.5 py-3 flex items-center gap-2.5 text-[12.5px]",
                        "transition-border-color duration-150 ease-[var(--ease-out)]",
                        "hover:border-[var(--border-hover)]"
                      )}
                      key={g.label}
                    >
                      <GateDot status={g.status} />
                      <div>
                        <div className="font-semibold text-[12.5px]">
                          {g.label}
                        </div>
                        <div className="text-[11px] text-[var(--muted)] mt-0.5">
                          {g.detail}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Manager cycle">
              {managerCycle ? (
                <div>
                  <div className="flex items-center gap-3 px-3.5 py-3 bg-[var(--panel-2)] border border-[var(--border)] rounded-xl text-[13px] mb-2.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-positive shadow-glow-positive animate-pulse-cycle" />
                    <div>
                      <strong>{managerCycle.source}</strong>
                      <span className="mx-2 text-[var(--muted)]">&middot;</span>
                      {managerCycle.phase}
                      <span className="mx-2 text-[var(--muted)]">&middot;</span>
                      {fmtRel(managerCycle.updatedAt)}
                    </div>
                  </div>
                  <div className="text-[12.5px] text-[var(--muted)]">
                    {managerCycle.message}
                  </div>
                  <div className="h-1.5 rounded-[3px] bg-[var(--panel-3)] overflow-hidden mt-2">
                    <div
                      className="h-full rounded-[3px] transition-[width] duration-500 ease-[var(--ease-out)]"
                      style={{
                        width: `${managerCycle.percent}%`,
                        background:
                          managerCycle.percent >= 80
                            ? "var(--linked)"
                            : managerCycle.percent >= 40
                              ? "var(--cluster)"
                              : "var(--accent)",
                      }}
                    />
                  </div>
                  <div className="text-[11px] text-[var(--muted)] mt-1 text-right">
                    {managerCycle.percent}%
                  </div>
                </div>
              ) : (
                <EmptyState>No manager cycle data yet.</EmptyState>
              )}
              {management && management.progress.length > 1 && (
                <div className="mt-3">
                  <div className="text-2xs uppercase tracking-[0.08em] text-[var(--muted)] mb-1.5 font-bold">
                    Recent progress
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {management.progress.slice(1, 5).map((p) => (
                      <div
                        className="flex gap-2.5 items-baseline text-[12.5px] py-2 border-b border-b-[rgba(30,30,46,0.4)] last:border-b-0"
                        key={p.id}
                      >
                        <span className="text-[var(--muted)] text-[11px] whitespace-nowrap min-w-16 font-medium">
                          {fmtRel(p.updatedAt)}
                        </span>
                        <Badge text={`${p.percent}%`} tone="#60a5fa" />
                        <span className="flex-1 min-w-0">
                          <strong>{p.source}</strong> &middot; {p.phase}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card title="Deploy gate events" span={2}>
              {deployGates.length === 0 ? (
                <EmptyState>No deploy gate events recorded.</EmptyState>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto">
                  {deployGates.map((e) => (
                    <div
                      className="flex gap-2.5 items-baseline text-[12.5px] py-2 border-b border-b-[rgba(30,30,46,0.4)] last:border-b-0"
                      key={e.id}
                    >
                      <span className="text-[var(--muted)] text-[11px] whitespace-nowrap min-w-16 font-medium">
                        {fmtRel(e.ts)}
                      </span>
                      <Badge text={e.action ?? e.event} />
                      <span className="flex-1 min-w-0">
                        {e.poolName ? <strong>{e.poolName} </strong> : null}
                        {e.summary}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Recent LLM decisions">
              {recentDecisions.length === 0 ? (
                <EmptyState>No LLM decisions recorded.</EmptyState>
              ) : (
                <div className="max-h-[420px] overflow-y-auto">
                  {recentDecisions.map((r, i) => (
                    <div
                      className={cn(
                        "px-3 py-2.5 bg-[var(--panel-2)] border border-[var(--border)] rounded-10 mb-2",
                        "transition-border-color duration-150 ease-[var(--ease-out)]",
                        "hover:border-[var(--border-hover)]"
                      )}
                      key={`${r.poolName}-${r.ts}-${i}`}
                    >
                      <div className="flex items-center gap-2 mb-1.5 text-[12.5px]">
                        <strong>{r.poolName}</strong>
                        {r.action && <Badge text={r.action} />}
                        {r.confidence !== undefined && (
                          <span className="text-[11px] text-[var(--muted)]">
                            {fmtPct(r.confidence * 100, 0)} conf
                          </span>
                        )}
                      </div>
                      <div className="flex gap-3.5 text-[11px] text-[var(--muted)] font-medium">
                        <span>{r.model}</span>
                        <span>{r.promptTokens}+{r.completionTokens} tok</span>
                        <span>{r.latencyMs}ms</span>
                        <span>{fmtUsd(r.costUsd)}</span>
                        <span>{fmtRel(r.ts)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Live activity feed">
              {activityFeed.length === 0 ? (
                <EmptyState>No activity yet.</EmptyState>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto">
                  {activityFeed.map((j) => (
                    <div
                      className="flex gap-2.5 items-baseline text-[12.5px] py-2 border-b border-b-[rgba(30,30,46,0.4)] last:border-b-0"
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
                "rounded-xl px-4 py-3"
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
