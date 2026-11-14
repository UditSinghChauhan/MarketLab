import { afterEach, describe, expect, it } from "vitest";

import { Exchange } from "./exchange.js";
import { notional, paise, subtract } from "./money.js";
import type { OrderId } from "./order.js";
import {
  START_CASH,
  START_SHARES,
  SYMBOL,
  acceptedId,
  limit,
  makeExchange,
  market,
  ofType,
  rs,
  stop,
} from "./test-helpers.js";

let exchange: Exchange;

// Every scenario must leave the engine fully consistent.
afterEach(() => {
  expect(exchange.audit()).toEqual([]);
});

const trades = (events: ReturnType<Exchange["submit"]>) =>
  ofType(events, "trade").map((t) => ({ price: t.price, qty: t.qty, sell: t.sellAccountId }));

describe("resting and depth", () => {
  it("rests a limit order that does not cross", () => {
    exchange = makeExchange();
    const events = exchange.submit(limit("alice", "buy", 10, rs("99")));

    expect(events.map((e) => e.type)).toEqual(["order.accepted", "order.rested"]);
    expect(exchange.depth(SYMBOL)?.bids).toEqual([{ price: rs("99"), qty: 10, orders: 1 }]);
    expect(exchange.accounts.snapshot("alice").cash).toEqual({
      available: subtract(START_CASH, rs("990")),
      reserved: rs("990"),
    });
  });

  it("aggregates depth per price level, best price first", () => {
    exchange = makeExchange();
    exchange.submit(limit("alice", "sell", 5, rs("101")));
    exchange.submit(limit("bob", "sell", 7, rs("100.50")));
    exchange.submit(limit("carol", "sell", 3, rs("101")));

    expect(exchange.depth(SYMBOL)?.asks).toEqual([
      { price: rs("100.50"), qty: 7, orders: 1 },
      { price: rs("101"), qty: 8, orders: 2 },
    ]);
  });

  it("assigns deterministic ids and strictly increasing sequence numbers", () => {
    exchange = makeExchange();
    const events = [
      ...exchange.submit(limit("alice", "sell", 5, rs("101"))),
      ...exchange.submit(limit("bob", "buy", 5, rs("101"))),
    ];
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(acceptedId(events)).toBe("ord_1");
  });
});

describe("price-time priority", () => {
  it("fills the best price first", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 5, rs("101")));
    exchange.submit(limit("carol", "sell", 5, rs("100")));

    const events = exchange.submit(market("alice", "buy", 5));
    expect(trades(events)).toEqual([{ price: rs("100"), qty: 5, sell: "carol" }]);
  });

  it("fills the earliest order first at the same price", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 5, rs("100")));
    exchange.submit(limit("carol", "sell", 5, rs("100")));

    const events = exchange.submit(market("alice", "buy", 5));
    expect(trades(events)).toEqual([{ price: rs("100"), qty: 5, sell: "bob" }]);
  });

  it("walks the book: a large market order takes successive levels", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 5, rs("100")));
    exchange.submit(limit("carol", "sell", 5, rs("101")));

    const events = exchange.submit(market("alice", "buy", 8));
    expect(trades(events)).toEqual([
      { price: rs("100"), qty: 5, sell: "bob" },
      { price: rs("101"), qty: 3, sell: "carol" },
    ]);
    expect(exchange.depth(SYMBOL)?.asks).toEqual([{ price: rs("101"), qty: 2, orders: 1 }]);
  });
});

describe("fills and settlement", () => {
  it("rests the remainder of a partially filled limit order", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 5, rs("100")));
    const events = exchange.submit(limit("alice", "buy", 8, rs("100")));

    expect(events.map((e) => e.type)).toEqual([
      "order.accepted",
      "trade",
      "order.filled", // bob's order
      "order.rested", // alice's remaining 3
    ]);
    expect(ofType(events, "order.rested")[0]?.remaining).toBe(3);
  });

  it("trades at the resting price and refunds the buyer's unused reservation", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 10, rs("100")));
    exchange.submit(limit("alice", "buy", 10, rs("105")));

    const alice = exchange.accounts.snapshot("alice");
    const bob = exchange.accounts.snapshot("bob");
    const cost = notional(rs("100"), 10);
    expect(alice.cash).toEqual({ available: subtract(START_CASH, cost), reserved: 0 });
    expect(alice.positions[SYMBOL]).toEqual({ available: START_SHARES + 10, reserved: 0 });
    expect(bob.cash.available).toBe(START_CASH + cost);
    expect(bob.positions[SYMBOL]).toEqual({ available: START_SHARES - 10, reserved: 0 });
  });

  it("updates the last traded price", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 1, rs("102.50")));
    exchange.submit(market("alice", "buy", 1));
    expect(exchange.lastPrice(SYMBOL)).toBe(rs("102.50"));
  });
});

describe("market orders", () => {
  it("cancels whatever cannot fill instead of resting it", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 3, rs("100")));
    const events = exchange.submit(market("alice", "buy", 5));

    const cancelled = ofType(events, "order.cancelled")[0];
    expect(cancelled).toMatchObject({ remaining: 2, reason: "no_liquidity" });
    expect(exchange.openOrders("alice")).toEqual([]);
  });

  it("stops buying when the account runs out of cash", () => {
    exchange = makeExchange(["bob"]);
    exchange.accounts.open("dave", rs("250"));
    exchange.submit(limit("bob", "sell", 10, rs("100")));

    const events = exchange.submit(market("dave", "buy", 10));
    expect(trades(events)).toEqual([{ price: rs("100"), qty: 2, sell: "bob" }]);
    expect(ofType(events, "order.cancelled")[0]).toMatchObject({
      remaining: 8,
      reason: "insufficient_funds",
    });
    expect(exchange.accounts.snapshot("dave").cash.available).toBe(rs("50"));
  });
});

describe("validation", () => {
  it.each([
    ["unknown account", market("mallory", "buy", 1), "unknown_account"],
    ["unknown symbol", { ...market("alice", "buy", 1), symbol: "NOPE" }, "unknown_symbol"],
    ["off-tick price", limit("alice", "buy", 1, rs("100.01")), "off_tick"],
    ["zero price", limit("alice", "buy", 1, paise(0)), "invalid_price"],
    ["non-integer quantity", { ...market("alice", "buy", 1), qty: 1.5 }, "invalid_quantity"],
    ["buy beyond cash", limit("alice", "buy", 2_000, rs("100")), "insufficient_funds"],
    [
      "sell beyond shares",
      limit("alice", "sell", START_SHARES + 1, rs("100")),
      "insufficient_shares",
    ],
    [
      "stop sell beyond shares",
      stop("alice", "sell", START_SHARES + 1, rs("90")),
      "insufficient_shares",
    ],
  ] as const)("rejects %s", (_name, command, reason) => {
    exchange = makeExchange();
    const events = exchange.submit(command as Parameters<Exchange["submit"]>[0]);
    expect(events).toEqual([expect.objectContaining({ type: "order.rejected", reason })]);
    expect(exchange.accounts.snapshot("alice").cash.reserved).toBe(0);
  });

  it("rejects an order whose notional overflows instead of throwing", () => {
    exchange = makeExchange();
    // ₹10 trillion × 10 shares does not fit in a safe integer of paise.
    const events = exchange.submit(limit("alice", "buy", 10, paise(1e15)));
    expect(events[0]).toMatchObject({ type: "order.rejected", reason: "insufficient_funds" });
  });

  it("does not let two sell orders promise the same shares", () => {
    exchange = makeExchange();
    exchange.submit(limit("alice", "sell", START_SHARES, rs("110")));
    const events = exchange.submit(limit("alice", "sell", 1, rs("111")));
    expect(events[0]).toMatchObject({ reason: "insufficient_shares" });
  });
});

describe("cancel", () => {
  it("removes the order and releases its reservation", () => {
    exchange = makeExchange();
    const id = acceptedId(exchange.submit(limit("alice", "buy", 10, rs("99"))));
    const events = exchange.submit({ kind: "cancel", accountId: "alice", orderId: id });

    expect(events).toEqual([
      expect.objectContaining({
        type: "order.cancelled",
        orderId: id,
        remaining: 10,
        reason: "user",
      }),
    ]);
    expect(exchange.accounts.snapshot("alice").cash).toEqual({
      available: START_CASH,
      reserved: 0,
    });
    expect(exchange.depth(SYMBOL)?.bids).toEqual([]);
  });

  it("rejects cancelling someone else's order", () => {
    exchange = makeExchange();
    const id = acceptedId(exchange.submit(limit("alice", "buy", 10, rs("99"))));
    const events = exchange.submit({ kind: "cancel", accountId: "bob", orderId: id });
    expect(events[0]).toMatchObject({ type: "order.rejected", reason: "not_owner" });
  });

  it("rejects cancelling an order that already filled", () => {
    exchange = makeExchange();
    const id = acceptedId(exchange.submit(limit("alice", "sell", 5, rs("100"))));
    exchange.submit(market("bob", "buy", 5));
    const events = exchange.submit({ kind: "cancel", accountId: "alice", orderId: id });
    expect(events[0]).toMatchObject({ type: "order.rejected", reason: "unknown_order" });
  });

  it("rejects an unknown order id", () => {
    exchange = makeExchange();
    const events = exchange.submit({
      kind: "cancel",
      accountId: "alice",
      orderId: "ord_404" as OrderId,
    });
    expect(events[0]).toMatchObject({ reason: "unknown_order" });
  });
});

describe("self-trade prevention", () => {
  it("cancels the account's own resting order instead of trading with it", () => {
    exchange = makeExchange();
    exchange.submit(limit("alice", "sell", 5, rs("100")));
    exchange.submit(limit("bob", "sell", 5, rs("101")));

    const events = exchange.submit(market("alice", "buy", 5));
    expect(ofType(events, "order.cancelled")[0]).toMatchObject({ reason: "self_trade" });
    expect(trades(events)).toEqual([{ price: rs("101"), qty: 5, sell: "bob" }]);
  });
});

describe("stop orders", () => {
  it("waits, then triggers as a market order when the last price reaches the stop", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "buy", 5, rs("99")));
    exchange.submit(limit("bob", "buy", 20, rs("98")));

    const placed = exchange.submit(stop("alice", "sell", 10, rs("99")));
    expect(placed.map((e) => e.type)).toEqual(["order.accepted"]);
    expect(exchange.openOrders("alice")[0]?.status).toBe("pending_stop");

    // carol sells into the 99 bid: last price drops to 99, alice's stop fires
    const events = exchange.submit(market("carol", "sell", 5));
    expect(events.map((e) => e.type)).toEqual([
      "order.accepted",
      "trade", // carol → bob @ 99
      "order.filled", // bob's 99 bid
      "order.filled", // carol
      "stop.triggered",
      "trade", // alice → bob @ 98
      "order.filled", // alice
    ]);
    expect(trades(events)[1]).toEqual({ price: rs("98"), qty: 10, sell: "alice" });
  });

  it("reserves shares for a stop sell and releases them on cancel", () => {
    exchange = makeExchange();
    const id = acceptedId(exchange.submit(stop("alice", "sell", 10, rs("90"))));
    expect(exchange.accounts.snapshot("alice").positions[SYMBOL]?.reserved).toBe(10);

    exchange.submit({ kind: "cancel", accountId: "alice", orderId: id });
    expect(exchange.accounts.snapshot("alice").positions[SYMBOL]).toEqual({
      available: START_SHARES,
      reserved: 0,
    });
  });

  it("triggers immediately when the price is already through the stop", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "sell", 5, rs("100")));
    // last price is the reference price, 100: a buy stop at 95 is already through
    const events = exchange.submit(stop("alice", "buy", 5, rs("95")));
    expect(events.map((e) => e.type)).toEqual([
      "order.accepted",
      "stop.triggered",
      "trade",
      "order.filled",
      "order.filled",
    ]);
  });

  it("cascades: one stop's fill can trigger the next", () => {
    exchange = makeExchange();
    exchange.submit(limit("bob", "buy", 1, rs("99")));
    exchange.submit(limit("bob", "buy", 1, rs("97")));
    exchange.submit(limit("bob", "buy", 1, rs("95")));
    exchange.submit(stop("alice", "sell", 1, rs("99"))); // fills at 97
    exchange.submit(stop("carol", "sell", 1, rs("97"))); // fills at 95

    const events = exchange.submit(market("carol", "sell", 1)); // hits 99
    expect(ofType(events, "stop.triggered")).toHaveLength(2);
    expect(trades(events).map((t) => t.price)).toEqual([rs("99"), rs("97"), rs("95")]);
  });
});

describe("open orders", () => {
  it("lists an account's open orders oldest first with remaining quantity", () => {
    exchange = makeExchange();
    exchange.submit(limit("alice", "buy", 10, rs("98")));
    exchange.submit(stop("alice", "sell", 4, rs("90")));
    exchange.submit(limit("bob", "sell", 6, rs("98")));

    expect(exchange.openOrders("alice").map((o) => [o.order.type, o.remaining, o.status])).toEqual([
      ["limit", 4, "resting"],
      ["stop", 4, "pending_stop"],
    ]);
  });
});
