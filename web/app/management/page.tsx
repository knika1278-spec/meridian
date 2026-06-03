"use client";

import { useLiveData } from "@/lib/use-live-data";
import type { DashboardSnapshot } from "@/lib/dashboard";
import { cn } from "@/lib/cn";
import {
  Badge,
  Card,
  EmptyState,
  LiveControls,
  Truncate,
  fmtRel,
} from "@/components/ui";

export default function ManagementPage() {
  const { data, error, lastUpdated, live, setLive, reload } =
    useLiveData<DashboardSnapshot>("/api/dashboard");

  const m = data?.management;

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <h1 className="text-xl m-0 font-bold tracking-tight">Management</h1>
        <div className="flex-1" />
        <LiveControls
          live={live}
          setLive={setLive}
          reload={reload}
          lastUpdated={lastUpdated}
          error={error}
        />
      </header>

      {!m ? (
        <EmptyState>
          {error ? `Could not load: ${error}` : "Loading…"}
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3.5">
            <Card title="Manager events">
              {m.events.length === 0 ? (
                <EmptyState>No manager events yet.</EmptyState>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto">
                  {m.events.map((e) => (
                    <div
                      className="flex gap-2.5 items-baseline text-[12.5px] py-2 border-b border-b-[rgba(30,30,46,0.4)] last:border-b-0"
                      key={e.id}
                    >
                      <span className="text-[var(--muted)] text-[11px] whitespace-nowrap min-w-16 font-medium">
                        {fmtRel(e.ts)}
                      </span>
                      <Badge text={e.action ?? e.status} />
                      <span className="flex-1 min-w-0">
                        {e.poolName ? <strong>{e.poolName} </strong> : null}
                        {e.summary}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Cycle progress">
              {m.progress.length === 0 ? (
                <EmptyState>No progress events.</EmptyState>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto">
                  {m.progress.map((p) => (
                    <div
                      className="flex gap-2.5 items-baseline text-[12.5px] py-2 border-b border-b-[rgba(30,30,46,0.4)] last:border-b-0"
                      key={p.id}
                    >
                      <span className="text-[var(--muted)] text-[11px] whitespace-nowrap min-w-16 font-medium">
                        {fmtRel(p.updatedAt)}
                      </span>
                      <Badge text={`${p.percent}%`} tone="#60a5fa" />
                      <span className="flex-1 min-w-0">
                        <strong>{p.source}</strong> &middot; {p.phase} —{" "}
                        {p.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="h-4" />

          <Card title="Lessons">
            {m.lessons.length === 0 ? (
              <EmptyState>No lessons mined yet.</EmptyState>
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
                        Rule for the future
                      </th>
                      <th className="text-left text-[var(--muted)] font-bold text-2xs uppercase tracking-[0.08em] px-2.5 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] z-[1]">
                        Tags
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.lessons.map((l) => (
                      <tr
                        key={l.id}
                        className="hover:bg-[var(--panel-2)] even:bg-[rgba(255,255,255,0.01)]"
                      >
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {fmtRel(l.ts)}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {l.poolName ? (
                            <Truncate text={l.poolName} max={18} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {l.ruleForFuture}
                        </td>
                        <td className="px-2.5 py-2.5 border-b border-[rgba(30,30,46,0.5)] align-top">
                          {l.tags.map((t) => (
                            <Badge key={t} text={t} tone="#8b97ad" />
                          ))}
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
