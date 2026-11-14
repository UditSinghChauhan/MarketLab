import { describe, expect, it } from "vitest";

import { Exchange } from "./exchange.js";
import { parseRupees } from "./money.js";
import { quantity } from "./price.js";
import { MarketSimulator, mulberry32 } from "./simulator.js";

const SYMBOL = "ACME";

function demoMarket(seed: number): { exchange: Exchange; sim: MarketSimulator } {
  const exchange = new Exchange([
    { symbol: SYMBOL, tickSize: parseRupees("0.05"), referencePrice: parseRupees("100") },
  ]);
  exchange.accounts.open("maker", parseRupees("10000000"), { [SYMBOL]: 100_000 });
  for (const id of ["t1", "t2", "t3"]) {
    exchange.accounts.open(id, parseRupees("500000"), { [SYMBOL]: 2_000 });
  }
  const sim = new MarketSimulator(exchange, {
    symbol: SYMBOL,
    seed,
    makerId: "maker",
    takerIds: ["t1", "t2", "t3"],
  });
  return { exchange, sim };
}

describe("mulberry32", () => {
  it("is reproducible for a seed and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1_000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("MarketSimulator", () => {
  it("keeps a live two-sided book and every invariant over a long run", () => {
    const { exchange, sim } = demoMarket(7);
    let tradeCount = 0;
    for (let step = 0; step < 2_000; step++) {
      tradeCount += sim.step().filter((e) => e.type === "trade").length;
      expect(exchange.audit()).toEqual([]);
    }
    const depth = exchange.depth(SYMBOL);
    expect(depth?.bids.length).toBeGreaterThan(0);
    expect(depth?.asks.length).toBeGreaterThan(0);
    expect(tradeCount).toBeGreaterThan(500);
  });

  it("produces the same market for the same seed", () => {
    const a = demoMarket(123);
    const b = demoMarket(123);
    for (let step = 0; step < 300; step++) {
      expect(a.sim.step()).toEqual(b.sim.step());
    }
    expect(a.exchange.lastPrice(SYMBOL)).toBe(b.exchange.lastPrice(SYMBOL));
  });

  it("produces a different market for a different seed", () => {
    const a = demoMarket(1);
    const b = demoMarket(2);
    for (let step = 0; step < 100; step++) {
      a.sim.step();
      b.sim.step();
    }
    expect(a.exchange.lastPrice(SYMBOL)).not.toBe(b.exchange.lastPrice(SYMBOL));
  });

  it("spaces quoted levels by levelGapTicks", () => {
    const exchange = new Exchange([
      { symbol: SYMBOL, tickSize: parseRupees("0.05"), referencePrice: parseRupees("100") },
    ]);
    exchange.accounts.open("maker", parseRupees("10000000"), { [SYMBOL]: 100_000 });
    const sim = new MarketSimulator(exchange, {
      symbol: SYMBOL,
      seed: 3,
      makerId: "maker",
      takerIds: [],
      levelGapTicks: 4,
      volatilityTicks: 0,
    });
    sim.step();
    const asks = exchange.depth(SYMBOL)?.asks.map((l) => l.price) ?? [];
    expect(asks.slice(1).map((p, i) => p - (asks[i] ?? 0))).toEqual([20, 20, 20, 20]);
  });

  it("lets a human order trade against the bots", () => {
    const { exchange, sim } = demoMarket(9);
    exchange.accounts.open("you", parseRupees("100000"));
    sim.step();
    const events = exchange.submit({
      kind: "place",
      accountId: "you",
      symbol: SYMBOL,
      side: "buy",
      type: "market",
      qty: quantity(10),
    });
    expect(events.some((e) => e.type === "trade" && e.buyAccountId === "you")).toBe(true);
    expect(exchange.audit()).toEqual([]);
  });
});
