"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectionStatus = "connected" | "reconnecting" | "error";

export interface LiveData<T> {
  data: T | null;
  error: string | null;
  lastUpdated: number | null;
  live: boolean;
  setLive: (v: boolean) => void;
  reload: () => void;
  connectionStatus: ConnectionStatus;
  retryCount: number;
}

export function useLiveData<T>(
  url: string,
  pollMs = 30_000,
  maxRetries = 3,
): LiveData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [live, setLive] = useState(true);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connected");
  const [retryCount, setRetryCount] = useState(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  const retryRef = useRef(0);

  const reload = useCallback(
    async (isRetry = false) => {
      if (!isRetry) {
        retryRef.current = 0;
        setRetryCount(0);
      }
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as T & { error?: string };
        if (json && typeof json === "object" && "error" in json && json.error) {
          throw new Error(String(json.error));
        }
        setData(json);
        setLastUpdated(Date.now());
        setError(null);
        setConnectionStatus("connected");
        retryRef.current = 0;
        setRetryCount(0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        retryRef.current += 1;
        setRetryCount(retryRef.current);

        if (retryRef.current <= maxRetries) {
          setConnectionStatus("reconnecting");
          const backoff = Math.min(
            1000 * Math.pow(2, retryRef.current - 1),
            30_000,
          );
          setTimeout(() => {
            if (liveRef.current) reload(true);
          }, backoff);
        } else {
          setConnectionStatus("error");
        }
      }
    },
    [url, maxRetries],
  );

  useEffect(() => {
    reload();
    const t = setInterval(() => {
      if (liveRef.current) reload();
    }, pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);

  return {
    data,
    error,
    lastUpdated,
    live,
    setLive,
    reload: () => reload(),
    connectionStatus,
    retryCount,
  };
}
