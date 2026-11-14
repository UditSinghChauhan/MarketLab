import { Exchange, paise, quantity } from "@marketlab/engine";
import { describe, expect, it } from "vitest";

import { INSTRUMENTS } from "./instruments.js";
import { CANDLE_MS, MarketData } from "./market-data.js";

const SYMBOL = "ORBT";
const T0 = Date.UTC(2026, 10, 14, 9, 15);

function setup() {
  const exchange = new Exchange(INSTRUMENTS);
  const data = new MarketData(INSTRUMENTS);
  exchange.accounts.open("g_me", paise(100_000_000));
  exchange.accounts.open("mm", paise(100_000_000_00), { [SYMBOL]: 1_000_000 });
  data.registerHuman("g_me");
  const run = (at: number, ...commands: Parameters<Exchange["submit"]>[0][]) => {
    for (const c of commands) data.ingest(exchange.submit(c), at);
  };
  const ask = (price: number, qty: number) =>
    ({
      kind: "place",
      accountId: "mm",
      symbol: SYMBOL,
      side: "sell",
      type: "limit",
      qty: quantity(qty),
      limitPrice: paise(price),
    }) as const;
  const bid = (price: number, qty: number) => ({ ...ask(price, qty), side: "buy" }) as const;
  const mine = (side: "buy" | "sell", qty: number) =>
    ({
      kind: "place",
      accountId: "g_me",
      symbol: SYMBOL,
      side,
      type: "market",
      qty: quantity(qty),
    }) as const;
  return { exchange, data, run, ask, bid, mine };
}

describe("MarketData", () => {
  it("tracks average cost and realised P&L", () => {
    const { data, run, ask, bid, mine } = setup();
    run(T0, ask(100_000, 10), mine("buy", 10)); // 10 @ ₹1000
    run(T0, ask(110_000, 10), mine("buy", 10)); // 10 @ ₹1100 → avg ₹1050
    expect(data.costBasis("g_me", SYMBOL)).toEqual({ qty: 20, cost: 2_100_000, realized: 0 });

    run(T0, bid(120_000, 5), mine("sell", 5)); // sell 5 @ ₹1200: +₹150 each
    expect(data.costBasis("g_me", SYMBOL)).toEqual({ qty: 15, cost: 1_575_000, realized: 75_000 });
  });

  it("follows an order through its statuses with fill price", () => {
    const { data, run, ask, mine } = setup();
    run(T0, ask(100_000, 4), ask(100_500, 6), mine("buy", 10));
    const [order] = data.ordersOf("g_me");
    expect(order).toMatchObject({
      status: "filled",
      filled: 10,
      remaining: 0,
      avgFillPrice: "1003.00", // (4 × 1000 + 6 × 1005) / 10
    });
    expect(data.trace(order?.id ?? "")?.events.map((e) => e.type)).toEqual([
      "order.accepted",
      "trade",
      "trade",
      "order.filled",
    ]);
  });

  it("does not track bot orders", () => {
    const { data, run, ask } = setup();
    run(T0, ask(100_000, 4));
    expect(data.ordersOf("mm")).toEqual([]);
  });

  it("builds OHLCV candles per bucket and session stats", () => {
    const { data, run, ask, mine } = setup();
    run(T0, ask(100_000, 1), mine("buy", 1));
    run(T0 + 1_000, ask(101_000, 1), mine("buy", 1));
    run(T0 + 2_000, ask(99_500, 1), mine("buy", 1));
    run(T0 + CANDLE_MS, ask(100_200, 1), mine("buy", 1));

    const candles = data.candles(SYMBOL);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      open: "1000.00",
      high: "1010.00",
      low: "995.00",
      close: "995.00",
      volume: 3,
    });
    expect(candles[1]).toMatchObject({ open: "1002.00", close: "1002.00", volume: 1 });
    expect(data.symbol(SYMBOL)).toMatchObject({ trades: 4, volume: 4, last: 100_200 });
    expect(data.tape(SYMBOL, 2).map((t) => t.price)).toEqual(["1002.00", "995.00"]);
  });
});
