import type { HealthResponse } from "@marketlab/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POLL_MS, SLOW_AFTER_MS, createHealthMonitor } from "./health";

const health = { status: "ok", seq: 12 } as HealthResponse;

/** A health endpoint the test answers by hand, one request at a time. */
function server() {
  const pending: { resolve: (h: HealthResponse) => void; reject: (e: Error) => void }[] = [];
  const fetcher = vi.fn(
    () =>
      new Promise<HealthResponse>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const take = () => {
    const request = pending.shift();
    if (!request) throw new Error("No request in flight");
    return request;
  };
  return {
    fetcher,
    answer: async () => {
      take().resolve(health);
      await vi.advanceTimersByTimeAsync(0);
    },
    fail: async () => {
      take().reject(new Error("502"));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("health monitor", () => {
  it("is ready as soon as the server answers, without a starting state", async () => {
    const api = server();
    const monitor = createHealthMonitor(api.fetcher);
    const states: string[] = [];
    monitor.subscribe(() => states.push(monitor.get().state));

    await api.answer();
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    expect(states).toEqual(["ready"]);
    expect(monitor.get().health).toBe(health);
  });

  it("reports starting when the server has not answered within two seconds", async () => {
    const api = server();
    const monitor = createHealthMonitor(api.fetcher);
    monitor.subscribe(() => undefined);

    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS - 1);
    expect(monitor.get().state).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    expect(monitor.get().state).toBe("starting");
    expect(monitor.get().waitingSince).not.toBeNull();

    await api.answer(); // the slow first request finally lands
    expect(monitor.get()).toMatchObject({ state: "ready", waitingSince: null });
  });

  it("retries a failing server with growing delays, then goes live on its own", async () => {
    const api = server();
    const monitor = createHealthMonitor(api.fetcher);
    monitor.subscribe(() => undefined);

    await api.fail();
    expect(monitor.get().state).toBe("starting");
    for (const delay of [1_000, 2_000, 4_000, 8_000, 8_000]) {
      const calls = api.fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api.fetcher).toHaveBeenCalledTimes(calls); // still waiting
      await vi.advanceTimersByTimeAsync(1);
      expect(api.fetcher).toHaveBeenCalledTimes(calls + 1);
      await api.fail();
    }
    await vi.advanceTimersByTimeAsync(8_000);
    await api.answer();
    expect(monitor.get().state).toBe("ready");
  });

  it("ignores one missed poll on a live page but not two", async () => {
    const api = server();
    const monitor = createHealthMonitor(api.fetcher);
    monitor.subscribe(() => undefined);
    await api.answer();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await api.fail();
    expect(monitor.get().state).toBe("ready");
    await vi.advanceTimersByTimeAsync(1_000);
    await api.fail();
    expect(monitor.get()).toMatchObject({ state: "starting", health });
  });

  it("stops polling when nothing is subscribed", async () => {
    const api = server();
    const monitor = createHealthMonitor(api.fetcher);
    const unsubscribe = monitor.subscribe(() => undefined);
    await api.answer();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(api.fetcher).toHaveBeenCalledTimes(1);
  });
});
