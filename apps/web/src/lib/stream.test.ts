// @vitest-environment jsdom
import type {
  AccountView,
  Candle,
  MarketSummary,
  OrderBook,
  StreamMessage,
  TradePrint,
} from "@marketlab/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reducer, useMarketStream, type MarketState } from "./stream";

const start = (): MarketState => reducer({} as MarketState, { type: "reset", symbol: "ORBT" });
const candle = (time: number, close: string): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});
const trade = (seq: number, symbol = "ORBT"): TradePrint => ({
  seq,
  symbol,
  price: "1.00",
  qty: 1,
  aggressor: "buy",
  time: seq,
});

describe("stream reducer", () => {
  it("prepends trades newest first, caps the tape and ignores other symbols", () => {
    let state = start();
    for (let i = 0; i < 70; i++) {
      state = reducer(state, {
        type: "message",
        message: { type: "trades", symbol: "ORBT", trades: [trade(i)] },
      });
    }
    state = reducer(state, {
      type: "message",
      message: { type: "trades", symbol: "SOLR", trades: [trade(999, "SOLR")] },
    });
    expect(state.trades).toHaveLength(60);
    expect(state.trades[0]?.seq).toBe(69);
  });

  it("merges a reconnect's snapshot by seq: no repeats, newest first, at most 60", () => {
    const trades = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => trade(to - i)); // newest first
    let state = start();
    state = reducer(state, {
      type: "message",
      message: { type: "trades", symbol: "ORBT", trades: trades(1, 50) },
    });
    // The next connection's snapshot: the last 50 trades, 10 of them new.
    state = reducer(state, {
      type: "message",
      message: { type: "trades", symbol: "ORBT", trades: trades(11, 60) },
    });
    const seqs = state.trades.map((t) => t.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(trades(1, 60).map((t) => t.seq));

    state = reducer(state, {
      type: "message",
      message: { type: "trades", symbol: "ORBT", trades: trades(41, 70) },
    });
    expect(state.trades.map((t) => t.seq)).toEqual(trades(11, 70).map((t) => t.seq));
  });

  it("keeps the tape newest first when a batch arrives out of order", () => {
    let state = start();
    state = reducer(state, {
      type: "message",
      message: { type: "trades", symbol: "ORBT", trades: [trade(5), trade(3)] },
    });
    state = reducer(state, {
      type: "message",
      message: { type: "trades", symbol: "ORBT", trades: [trade(4), trade(6)] },
    });
    expect(state.trades.map((t) => t.seq)).toEqual([6, 5, 4, 3]);
  });

  it("updates the current candle in place and appends new ones", () => {
    let state = start();
    state = reducer(state, {
      type: "message",
      message: { type: "candle", symbol: "ORBT", candle: candle(0, "1.00") },
    });
    state = reducer(state, {
      type: "message",
      message: { type: "candle", symbol: "ORBT", candle: candle(0, "1.05") },
    });
    state = reducer(state, {
      type: "message",
      message: { type: "candle", symbol: "ORBT", candle: candle(15_000, "1.10") },
    });
    expect(state.candles.map((c) => c.close)).toEqual(["1.05", "1.10"]);
  });

  it("keeps streamed candles that arrived before the history request finished", () => {
    let state = start();
    state = reducer(state, {
      type: "message",
      message: { type: "candle", symbol: "ORBT", candle: candle(30_000, "2.00") },
    });
    state = reducer(state, {
      type: "candles",
      symbol: "ORBT",
      candles: [candle(0, "1.00"), candle(15_000, "1.50")],
    });
    expect(state.candles.map((c) => c.time)).toEqual([0, 15_000, 30_000]);
  });

  it("counts order updates so the order list can refresh", () => {
    let state = start();
    state = reducer(state, { type: "message", message: { type: "orders", events: [] } });
    state = reducer(state, { type: "message", message: { type: "orders", events: [] } });
    expect(state.ordersVersion).toBe(2);
  });

  it("goes live on hello and stores markets, this market's book and the account", () => {
    let state = start();
    expect(state.status).toBe("connecting");
    state = reducer(state, { type: "message", message: { type: "hello" } as StreamMessage });
    expect(state.status).toBe("live");
    state = reducer(state, { type: "message", message: { type: "markets", markets: [summary] } });
    expect(state.markets).toEqual([summary]);
    state = reducer(state, { type: "message", message: { type: "book", book: book("SOLR") } });
    expect(state.book).toBeNull();
    state = reducer(state, { type: "message", message: { type: "book", book: book("ORBT") } });
    expect(state.book?.symbol).toBe("ORBT");
    state = reducer(state, { type: "message", message: { type: "account", account } });
    expect(state.account).toBe(account);
    state = reducer(state, { type: "status", status: "reconnecting" });
    expect(state.status).toBe("reconnecting");
  });

  it("ignores candles for another market and candles older than the last one", () => {
    let state = start();
    const before = state;
    state = reducer(state, { type: "candles", symbol: "SOLR", candles: [candle(0, "9.00")] });
    expect(state).toBe(before);
    state = reducer(state, {
      type: "message",
      message: { type: "candle", symbol: "SOLR", candle: candle(0, "9.00") },
    });
    expect(state).toBe(before);
    state = reducer(state, {
      type: "message",
      message: { type: "candle", symbol: "ORBT", candle: candle(30_000, "1.00") },
    });
    state = reducer(state, {
      type: "message",
      message: { type: "candle", symbol: "ORBT", candle: candle(15_000, "0.50") },
    });
    expect(state.candles.map((c) => c.time)).toEqual([30_000]);
  });

  it("keeps the most recent 480 candles", () => {
    const history = Array.from({ length: 500 }, (_, i) => candle(i * 15_000, "1.00"));
    const state = reducer(start(), { type: "candles", symbol: "ORBT", candles: [] });
    const filled = history.reduce(
      (s, c) =>
        reducer(s, { type: "message", message: { type: "candle", symbol: "ORBT", candle: c } }),
      state,
    );
    expect(filled.candles).toHaveLength(480);
    expect(filled.candles[0]?.time).toBe(20 * 15_000);
  });
});

const summary: MarketSummary = {
  symbol: "ORBT",
  name: "Orbital",
  sector: "Space",
  tick: "0.05",
  last: "1.00",
  open: "1.00",
  high: "1.00",
  low: "1.00",
  change: "0.00",
  changePct: 0,
  bid: null,
  ask: null,
  volume: 0,
  trades: 0,
};
const book = (symbol: string): OrderBook => ({
  symbol,
  seq: 1,
  bids: [],
  asks: [],
  spread: null,
  mid: null,
});
const account: AccountView = {
  accountId: "a1",
  cash: { available: "1000000.00", reserved: "0.00" },
  positions: [],
  equity: "1000000.00",
  startingEquity: "1000000.00",
  pnl: "0.00",
  pnlPct: 0,
};

/** A stand-in EventSource the test drives by hand. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(message: StreamMessage) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  /** `closed`: the browser gave up (it retries other errors on its own). */
  fail(closed: boolean) {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

const latest = (): FakeEventSource => {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was opened");
  return source;
};

/** Answers the hook's two requests: candle history and the session check. */
function stubFetch({
  candles = [candle(0, "1.00")],
  account: accountStatus = 200,
}: {
  /** History to serve, an HTTP status to fail with, or a network failure. */
  candles?: Candle[] | number | "network";
  /** Status of the session check, or a network failure. */
  account?: number | "network";
} = {}) {
  const fetch = vi.fn((url: string) => {
    if (url.startsWith("/api/account")) {
      if (accountStatus === "network") return Promise.reject(new TypeError("offline"));
      return Promise.resolve(new Response("{}", { status: accountStatus }));
    }
    if (candles === "network") return Promise.reject(new TypeError("offline"));
    return Promise.resolve(
      typeof candles === "number"
        ? new Response("{}", { status: candles })
        : new Response(JSON.stringify(candles), { status: 200 }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const accountChecks = (fetch: ReturnType<typeof stubFetch>) =>
  fetch.mock.calls.filter(([url]) => url.startsWith("/api/account")).length;

describe("useMarketStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens one stream for the market and session, loads history and goes live", async () => {
    stubFetch();
    const { result } = renderHook(() => useMarketStream("ORBT", "tok"));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe("/api/stream?symbol=ORBT&token=tok");
    await waitFor(() => {
      expect(result.current.candlesLoaded).toBe(true);
    });
    expect(result.current.candles).toHaveLength(1);

    act(() => {
      latest().emit({ type: "hello" } as StreamMessage);
      latest().emit({ type: "markets", markets: [summary] });
    });
    expect(result.current.status).toBe("live");
    expect(result.current.markets).toEqual([summary]);
  });

  it("connects without a token for a visitor who has no session yet", () => {
    stubFetch();
    renderHook(() => useMarketStream("ORBT", null));
    expect(latest().url).toBe("/api/stream?symbol=ORBT");
  });

  it("opens nothing while disabled", () => {
    const fetch = stubFetch();
    const { result } = renderHook(() => useMarketStream("ORBT", "tok", { enabled: false }));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe("connecting");
  });

  it("shows an empty, loaded chart when the history request fails, and waits on a network error", async () => {
    stubFetch({ candles: 500 });
    const failed = renderHook(() => useMarketStream("ORBT", null));
    await waitFor(() => {
      expect(failed.result.current.candlesLoaded).toBe(true);
    });
    expect(failed.result.current.candles).toEqual([]);
    cleanup();

    stubFetch({ candles: "network" });
    const offline = renderHook(() => useMarketStream("ORBT", null));
    await act(() => Promise.resolve());
    expect(offline.result.current.candlesLoaded).toBe(false);
  });

  it("leaves a passing error to the browser's own reconnect", () => {
    const fetch = stubFetch();
    const { result } = renderHook(() => useMarketStream("ORBT", "tok"));
    act(() => {
      latest().fail(false);
    });
    expect(result.current.status).toBe("reconnecting");
    expect(accountChecks(fetch)).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reports an ended session when the closed stream's token is no longer accepted", async () => {
    const fetch = stubFetch({ account: 401 });
    const onSessionEnded = vi.fn();
    renderHook(() => useMarketStream("ORBT", "tok", { onSessionEnded }));
    act(() => {
      latest().fail(true);
    });
    await waitFor(() => {
      expect(onSessionEnded).toHaveBeenCalledOnce();
    });
    expect(fetch).toHaveBeenCalledWith("/api/account", {
      headers: { authorization: "Bearer tok" },
    });
  });

  it("reconnects after three seconds when the session is still valid", async () => {
    vi.useFakeTimers();
    stubFetch({ account: 200 });
    const onSessionEnded = vi.fn();
    renderHook(() => useMarketStream("ORBT", "tok", { onSessionEnded }));
    const first = latest();
    act(() => {
      first.fail(true);
    });
    await act(() => vi.advanceTimersByTimeAsync(2_999));
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest()).not.toBe(first);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it("keeps the session and retries when the session check cannot reach the server", async () => {
    vi.useFakeTimers();
    stubFetch({ account: "network" });
    const onSessionEnded = vi.fn();
    renderHook(() => useMarketStream("ORBT", "tok", { onSessionEnded }));
    act(() => {
      latest().fail(true);
    });
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it("reconnects a visitor's closed stream without checking a session", async () => {
    vi.useFakeTimers();
    const fetch = stubFetch();
    renderHook(() => useMarketStream("ORBT", null));
    act(() => {
      latest().fail(true);
    });
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(accountChecks(fetch)).toBe(0);
  });

  it("keeps the market on screen when a session starts, and drops an old account's data", () => {
    stubFetch();
    const { result, rerender } = renderHook(({ token }) => useMarketStream("ORBT", token), {
      initialProps: { token: null as string | null },
    });
    act(() => {
      latest().emit({ type: "markets", markets: [summary] });
    });

    rerender({ token: "first" });
    expect(latest().url).toBe("/api/stream?symbol=ORBT&token=first");
    expect(result.current.markets).toEqual([summary]);
    act(() => {
      latest().emit({ type: "account", account });
      latest().emit({
        type: "orders",
        events: [{ seq: 1, at: 0, type: "order.filled", orderId: "o1" }],
      });
    });
    expect(result.current.account).toEqual(account);

    rerender({ token: "second" });
    expect(result.current.markets).toEqual([summary]);
    expect(result.current.account).toBeNull();
    expect(result.current.lastOrderEvents).toEqual([]);
  });

  it("shows each trade once when the session's stream resends the tape", () => {
    stubFetch();
    const { result, rerender } = renderHook(({ token }) => useMarketStream("ORBT", token), {
      initialProps: { token: null as string | null },
    });
    const snapshot = (newest: number) => Array.from({ length: 50 }, (_, i) => trade(newest - i));
    act(() => {
      latest().emit({ type: "trades", symbol: "ORBT", trades: snapshot(50) });
    });
    rerender({ token: "tok" });
    act(() => {
      latest().emit({ type: "trades", symbol: "ORBT", trades: snapshot(52) });
    });
    const seqs = result.current.trades.map((t) => t.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.slice(0, 3)).toEqual([52, 51, 50]);
    expect(seqs).toHaveLength(52);
  });

  it("starts from empty on another market and closes the old stream", () => {
    stubFetch();
    const { result, rerender } = renderHook(({ symbol }) => useMarketStream(symbol, "tok"), {
      initialProps: { symbol: "ORBT" },
    });
    const first = latest();
    act(() => {
      first.emit({ type: "markets", markets: [summary] });
    });
    rerender({ symbol: "QNTA" });
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(latest().url).toBe("/api/stream?symbol=QNTA&token=tok");
    expect(result.current.symbol).toBe("QNTA");
    expect(result.current.markets).toEqual([]);
  });

  it("does nothing more once unmounted, even when a session check resolves late", async () => {
    vi.useFakeTimers();
    const fetch = stubFetch({ account: 401 });
    const onSessionEnded = vi.fn();
    const { unmount } = renderHook(() => useMarketStream("ORBT", "tok", { onSessionEnded }));
    const source = latest();
    act(() => {
      source.fail(true);
    });
    unmount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(accountChecks(fetch)).toBe(1);
    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
