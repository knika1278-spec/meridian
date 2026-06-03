"use client";

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
  fmtNum,
  fmtPct,
  fmtRel,
  fmtUsd,
} from "@/components/ui";

export default function ScreeningPage() {
  const { data, error, lastUpdated, live, setLive, reload } =
    useLiveData<DashboardSnapshot>("/api/dashboard");

  const s = data?.screening;

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <h1 className="text-xl m-0 font-bold tracking-tight">Screening</h1>
        <div className="flex-1" />
        <LiveControls
          live={live}
          setLive={setLive}
          reload={reload}
          lastUpdated={lastUpdated}
          error={error}
        />
      </header>

      {!s ? (
        <EmptyState>
          {error ? `Could not load: ${error}` : "Loading…"}
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-[18px]">
            <StatCard label="LLM calls" value={s.totals.calls} />
            <StatCard
              label="Total cost"
              value={fmtUsd(s.totals.costUsd)}
              accent="#a78bfa"
            />
            <StatCard
              label="Avg latency"
              value={`${fmtNum(s.totals.avgLatencyMs)}ms`}
            />
            <StatCard
              label="Candidates"
              value={s.candidates.length}
              sub={s.lastCycleId ? `cycle ${s.lastCycleId}` : undefined}
            />
            {Object.entries(s.totals.byAction).map(([action, count]) => (
              <StatCard key={action} label={action} value={count} />
            ))}
          </div>

          <Card title="Candidates (latest cycle)">
            {s.candidates.length === 0 ? (
              <EmptyState>No candidates in the latest cycle.</EmptyState>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Pool
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Decision
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Conf
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Organic
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        TVL
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Fee/TVL
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Filters
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.candidates.map((c) => (
                      <tr
                        key={c.address}
                        className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
                      >
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          <Truncate text={c.name} max={22} />
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {c.action ? <Badge text={c.action} /> : "—"}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {c.confidence !== undefined
                            ? fmtPct(c.confidence * 100, 0)
                            : "—"}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtNum(c.organicScore)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtUsd(c.tvlUsd)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {c.feeToTvlRatio !== undefined
                            ? fmtPct(c.feeToTvlRatio, 3)
                            : "—"}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {c.filtersPassed === undefined ? (
                            "—"
                          ) : (
                            <Badge
                              text={c.filtersPassed ? "PASS" : "FAIL"}
                              tone={c.filtersPassed ? "#34d399" : "#f87171"}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="h-4" />

          <Card title="LLM runs">
            {s.llmRuns.length === 0 ? (
              <EmptyState>No LLM runs recorded.</EmptyState>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        When
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Pool
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Model
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Decision
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Tokens
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Latency
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.llmRuns.map((r, i) => (
                      <tr
                        key={`${r.ts}-${i}`}
                        className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
                      >
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {fmtRel(r.ts)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          <Truncate text={r.poolName} max={20} />
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top font-mono text-xs font-medium">
                          {r.model}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {r.action ? <Badge text={r.action} /> : "—"}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtNum(r.promptTokens + r.completionTokens)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtNum(r.latencyMs)}ms
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtUsd(r.costUsd)}
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
