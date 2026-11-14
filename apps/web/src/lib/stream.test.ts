import type { Candle, TradePrint } from "@marketlab/contracts";
import { describe, expect, it } from "vitest";

import { reducer, type MarketState } from "./stream";

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
});
