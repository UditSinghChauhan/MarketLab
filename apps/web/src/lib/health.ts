/**
 * Is the exchange awake?
 *
 * The free hosting plan stops the server when nobody is using it, and the next
 * request takes up to a minute to wake it. Instead of showing errors, pages ask
 * this monitor: it polls /api/health, reports "starting" when the server has
 * not answered within two seconds, retries with backoff, and turns "ready" on
 * its own. One monitor is shared by every component on the page.
 */

import type { HealthResponse } from "@marketlab/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

export type ExchangeState = "checking" | "starting" | "ready";

export interface ExchangeStatus {
  readonly state: ExchangeState;
  /** The latest health report; kept while the server is away. */
  readonly health: HealthResponse | null;
  /** When the current wait began (epoch milliseconds), or null when ready. */
  readonly waitingSince: number | null;
}

export const SLOW_AFTER_MS = 2_000;
export const POLL_MS = 5_000;
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;
const ATTEMPT_TIMEOUT_MS = 20_000;

export type FetchHealth = (signal: AbortSignal) => Promise<HealthResponse>;

const fetchHealth: FetchHealth = async (signal) => {
  const response = await fetch("/api/health", { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Health check failed (${String(response.status)})`);
  return (await response.json()) as HealthResponse;
};

export function createHealthMonitor(fetcher: FetchHealth = fetchHealth, now = Date.now) {
  let status: ExchangeStatus = { state: "checking", health: null, waitingSince: null };
  const listeners = new Set<() => void>();
  let failures = 0;
  let run = 0; // increments on every start and stop, so a stale attempt can tell it is stale
  let next: ReturnType<typeof setTimeout> | undefined;
  let slow: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const set = (value: ExchangeStatus) => {
    status = value;
    for (const listener of listeners) listener();
  };

  const markStarting = () => {
    if (status.state === "starting") return;
    set({ state: "starting", health: status.health, waitingSince: status.waitingSince ?? now() });
  };

  const attempt = async (mine: number) => {
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => {
      request.abort();
    }, ATTEMPT_TIMEOUT_MS);
    try {
      const health = await fetcher(request.signal);
      if (mine !== run) return;
      failures = 0;
      clearTimeout(slow);
      set({ state: "ready", health, waitingSince: null });
      next = setTimeout(() => void attempt(mine), POLL_MS);
    } catch {
      if (mine !== run) return;
      failures += 1;
      // One missed poll on a live page is noise; two in a row means the server is away.
      if (status.state !== "ready" || failures >= 2) markStarting();
      const delay = RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] ?? 8_000;
      next = setTimeout(() => void attempt(mine), delay);
    } finally {
      clearTimeout(timeout);
    }
  };

  const start = () => {
    run += 1;
    failures = 0;
    if (status.state !== "ready") {
      status = { ...status, waitingSince: status.waitingSince ?? now() };
      slow = setTimeout(markStarting, SLOW_AFTER_MS);
    }
    void attempt(run);
  };

  const stop = () => {
    run += 1;
    clearTimeout(next);
    clearTimeout(slow);
    controller?.abort();
  };

  return {
    get: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
}

const monitor = createHealthMonitor();

export function useExchange(): ExchangeStatus {
  return useSyncExternalStore(monitor.subscribe, monitor.get);
}

/**
 * Asks whether the exchange is up while the page's code and fonts are still
 * loading, instead of after the first render. The check is held for a few
 * seconds, by when the page has subscribed if it needs it; otherwise polling
 * stops as usual.
 */
export function checkHealthEarly(holdMs = 10_000): void {
  const release = monitor.subscribe(() => undefined);
  setTimeout(release, holdMs);
}

/** Whole seconds since `since`, updated once a second; 0 when there is nothing to wait for. */
export function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1_000));
}
