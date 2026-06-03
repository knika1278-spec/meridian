"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui";

interface RealtimeRebalanceConfig {
  enabled: boolean;
  throttleMs: number;
  triggerOnSwap: boolean;
  triggerOnBinChange: boolean;
}

interface ManagerConfig {
  realtimeRebalance?: RealtimeRebalanceConfig;
  [key: string]: unknown;
}

interface Config {
  manager: ManagerConfig;
  [key: string]: unknown;
}

export default function ConfigPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Real-time rebalance form state
  const [rtEnabled, setRtEnabled] = useState(false);
  const [rtThrottleMs, setRtThrottleMs] = useState(10000);
  const [rtTriggerOnSwap, setRtTriggerOnSwap] = useState(true);
  const [rtTriggerOnBinChange, setRtTriggerOnBinChange] = useState(true);

  useEffect(() => {
    fetchConfig();
  }, []);

  async function fetchConfig() {
    try {
      setLoading(true);
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error("Failed to fetch config");
      const data = await res.json();
      setConfig(data);

      // Initialize form state
      const rt = data.manager?.realtimeRebalance;
      if (rt) {
        setRtEnabled(rt.enabled ?? false);
        setRtThrottleMs(rt.throttleMs ?? 10000);
        setRtTriggerOnSwap(rt.triggerOnSwap ?? true);
        setRtTriggerOnBinChange(rt.triggerOnBinChange ?? true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      setSaved(false);

      const update = {
        "manager.realtimeRebalance": {
          enabled: rtEnabled,
          throttleMs: rtThrottleMs,
          triggerOnSwap: rtTriggerOnSwap,
          triggerOnBinChange: rtTriggerOnBinChange,
        },
      };

      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="h-screen overflow-y-auto px-7 py-6">
        <h1 className="text-xl font-bold mb-4">Configuration</h1>
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-y-auto px-7 py-6 pb-[60px]">
      <header className="flex items-center gap-3.5 mb-[22px]">
        <h1 className="text-xl m-0 font-bold tracking-tight">Configuration</h1>
        <div className="flex-1" />
        {saved && (
          <span className="text-green-400 text-sm">
            ✓ Saved (hot-reload pending)
          </span>
        )}
        {error && <span className="text-red-400 text-sm">✗ {error}</span>}
      </header>

      {/* Real-time Rebalance */}
      <Card title="Real-time Rebalance Trigger">
        <div className="flex flex-col gap-4 text-[13px]">
          <p className="text-[var(--muted)] text-[12px]">
            Immediately rebalance positions when the active bin moves outside
            range, instead of waiting for the next cron cycle. Uses WebSocket
            events from Helius.
          </p>

          {/* Enabled toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={rtEnabled}
              onChange={(e) => setRtEnabled(e.target.checked)}
              className="w-4 h-4 accent-green-500"
            />
            <span className="font-medium">Enabled</span>
          </label>

          {/* Throttle */}
          <div className="flex flex-col gap-1.5">
            <label className="font-medium">
              Throttle (ms)
              <span className="text-[var(--muted)] font-normal ml-2">
                Min interval between evaluations per pool
              </span>
            </label>
            <input
              type="number"
              value={rtThrottleMs}
              onChange={(e) => setRtThrottleMs(Number(e.target.value))}
              min={1000}
              max={60000}
              step={1000}
              disabled={!rtEnabled}
              className="w-32 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded text-[13px] disabled:opacity-40"
            />
          </div>

          {/* Trigger on swap */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={rtTriggerOnSwap}
              onChange={(e) => setRtTriggerOnSwap(e.target.checked)}
              disabled={!rtEnabled}
              className="w-4 h-4 accent-green-500 disabled:opacity-40"
            />
            <span>Trigger on swap events</span>
          </label>

          {/* Trigger on bin change */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={rtTriggerOnBinChange}
              onChange={(e) => setRtTriggerOnBinChange(e.target.checked)}
              disabled={!rtEnabled}
              className="w-4 h-4 accent-green-500 disabled:opacity-40"
            />
            <span>Trigger on active bin change events</span>
          </label>

          {/* Save button */}
          <div className="flex gap-3 mt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-[var(--accent)] text-white rounded text-[13px] font-medium hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={fetchConfig}
              disabled={saving}
              className="px-4 py-2 bg-[var(--surface)] border border-[var(--border)] rounded text-[13px] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              Reset
            </button>
          </div>
        </div>
      </Card>

      {/* Current config preview */}
      <div className="mt-4">
        <Card title="Current Config (manager.realtimeRebalance)">
          <pre className="text-[12px] text-[var(--muted)] overflow-x-auto">
            {JSON.stringify(config?.manager?.realtimeRebalance ?? {}, null, 2)}
          </pre>
        </Card>
      </div>
    </div>
  );
}
