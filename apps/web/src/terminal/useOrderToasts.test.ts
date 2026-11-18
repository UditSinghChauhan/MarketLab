// @vitest-environment jsdom
import type { EventView, OrderView } from "@marketlab/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrderToasts } from "./useOrderToasts";

const resting: OrderView = {
  id: "o1",
  symbol: "QNTA",
  side: "sell",
  type: "limit",
  qty: 25,
  filled: 0,
  remaining: 25,
  price: "842.50",
  stopPrice: null,
  avgFillPrice: null,
  status: "resting",
  reason: null,
  createdAt: 0,
  updatedAt: 0,
};
const filled = (seq: number, orderId = "o1"): EventView => ({
  seq,
  at: 0,
  type: "order.filled",
  orderId,
});
const triggered = (seq: number, orderId = "o1"): EventView => ({
  seq,
  at: 0,
  type: "stop.triggered",
  orderId,
  lastPrice: "840.00",
});

function setup(orders: OrderView[] = [resting]) {
  return renderHook(({ events }) => useOrderToasts(events, orders), {
    initialProps: { events: [] as EventView[] },
  });
}

describe("useOrderToasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("announces a resting order that filled and a stop that fired", () => {
    const { result, rerender } = setup();
    rerender({ events: [filled(1)] });
    rerender({ events: [triggered(2)] });
    rerender({ events: [triggered(3, "unknown")] });
    expect(result.current.toasts.map((t) => t.text)).toEqual([
      "Sell 25 QNTA filled",
      "Stop sell QNTA triggered at ₹840.00",
      "Stop triggered at ₹840.00",
    ]);
  });

  it("stays quiet about the user's own actions and orders it has not listed yet", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.markOwn([filled(7)]);
    });
    rerender({ events: [filled(7)] });
    rerender({ events: [filled(8, "just-placed")] });
    rerender({ events: [{ seq: 9, at: 0, type: "order.rejected", reason: "off_tick" }] });
    expect(result.current.toasts).toEqual([]);
  });

  it("keeps the three newest toasts and removes each after four seconds", () => {
    const { result } = setup();
    act(() => {
      result.current.toast("one");
      result.current.toast("two", "info");
      result.current.toast("three");
      result.current.toast("four");
    });
    expect(result.current.toasts.map((t) => [t.text, t.tone])).toEqual([
      ["two", "info"],
      ["three", "ok"],
      ["four", "ok"],
    ]);
    act(() => {
      vi.advanceTimersByTime(3_999);
    });
    expect(result.current.toasts).toHaveLength(3);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toEqual([]);
  });
});
