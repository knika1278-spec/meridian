"use client";

import { useLiveData } from "@/lib/use-live-data";
import type { DashboardSnapshot, SignalFinding } from "@/lib/dashboard";
import { cn } from "@/lib/cn";
import {
  Badge,
  Card,
  EmptyState,
  LiveControls,
  StatCard,
  Truncate,
  fmtNum,
  fmtRel,
} from "@/components/ui";

export default function LearningPage() {
  const { data, error, lastUpdated, live, setLive, reload } =
    useLiveData<DashboardSnapshot>("/api/dashboard");

  const l = data?.learning;
  const snap = l?.snapshot;

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <h1 className="text-xl m-0 font-bold tracking-tight">Learning</h1>
        <div className="flex-1" />
        <LiveControls
          live={live}
          setLive={setLive}
          reload={reload}
          lastUpdated={lastUpdated}
          error={error}
        />
      </header>

      {!l ? (
        <EmptyState>
          {error ? `Could not load: ${error}` : "Loading…"}
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-[18px]">
            <StatCard label="Decisions" value={snap?.counts.decisions ?? 0} />
            <StatCard label="Outcomes" value={snap?.counts.outcomes ?? 0} />
            <StatCard label="Lessons" value={snap?.counts.lessons ?? 0} />
            <StatCard
              label="Shadow scores"
              value={snap?.counts.shadowScores ?? 0}
            />
            {snap &&
              Object.entries(snap.pendingByHorizon).map(([h, n]) => (
                <StatCard key={h} label={`Pending ${h}m`} value={n} />
              ))}
          </div>

          <div className="grid grid-cols-2 gap-3.5">
            <Card title="Top positive signals">
              <SignalTable
                rows={l.signalWeights?.topPositive ?? []}
                emptyText="No positive signals yet."
              />
            </Card>
            <Card title="Top negative signals">
              <SignalTable
                rows={l.signalWeights?.topNegative ?? []}
                emptyText="No negative signals yet."
              />
            </Card>
          </div>

          <div className="h-4" />

          <Card title="LLM / shadow disagreements">
            {l.disagreements.length === 0 ? (
              <EmptyState>No disagreements flagged.</EmptyState>
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
                        Bucket
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Expected
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Risk
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        N
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Note
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {l.disagreements.map((d) => (
                      <tr
                        key={d.decisionId}
                        className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
                      >
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {fmtRel(d.ts)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          <Truncate
                            text={d.poolName ?? d.decisionId}
                            max={18}
                          />
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top font-mono text-xs font-medium">
                          {d.bucketKey}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtNum(d.expectedScore, 2)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtNum(d.riskScore, 2)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {d.sampleSize}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {d.disagreement ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="h-4" />

          <Card title="Recent outcomes">
            {l.outcomes.length === 0 ? (
              <EmptyState>No outcomes evaluated yet.</EmptyState>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Evaluated
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Pool
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Horizon
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Kind
                      </th>
                      <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Net-PnL risk
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {l.outcomes.map((o, i) => (
                      <tr
                        key={`${o.decisionId}-${o.horizonMinutes}-${i}`}
                        className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
                      >
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {fmtRel(o.evaluatedAt)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          <Truncate
                            text={o.poolName ?? o.decisionId}
                            max={18}
                          />
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {o.horizonMinutes}m
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          <Badge text={o.kind} />
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
                          {fmtNum(o.netPnlRiskScore, 3)}
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

function SignalTable({
  rows,
  emptyText,
}: {
  rows: SignalFinding[];
  emptyText: string;
}) {
  if (rows.length === 0) return <EmptyState>{emptyText}</EmptyState>;
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
            Signal
          </th>
          <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
            Lift
          </th>
          <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
            N
          </th>
          <th className="text-right text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
            Conf
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.signal}
            className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
          >
            <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
              <Truncate text={r.signal} max={28} />
            </td>
            <td
              className={cn(
                "px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums",
                r.lift >= 0 ? "text-positive" : "text-negative"
              )}
            >
              {fmtNum(r.lift, 3)}
            </td>
            <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
              {r.sampleSize}
            </td>
            <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top text-right tabular-nums">
              {fmtNum(r.confidence, 2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
