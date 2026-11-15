/**
 * Property-based tests: random command sequences, invariants checked after
 * every command.
 *
 * `Exchange.audit()` covers the state invariants:
 * - cash and shares are conserved across all accounts (no balance goes negative);
 * - every account's reserved balances equal what its open orders reserve;
 * - the book is never crossed, levels are sorted, totals match, and time priority holds;
 * - no stop is left untriggered once the last price has reached it.
 *
 * This file adds invariants over the event stream:
 * - limit orders never trade at a worse price than their limit;
 * - a trade always takes the best price on the book at that moment;
 * - every accepted order ends exactly once (filled or cancelled) or is still open.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Command, EngineEvent } from "./events.js";
import { Exchange, type ExchangeState } from "./exchange.js";
import { paise } from "./money.js";
import type { Order, OrderId } from "./order.js";
import { quantity } from "./price.js";
import { SYMBOL, TICK, makeExchange, rs } from "./test-helpers.js";

const ACCOUNTS = ["alice", "bob", "carol"] as const;

/** Prices within a few ticks of the ₹100 reference, so orders actually cross. */
const priceArb = fc.integer({ min: -8, max: 8 }).map((t) => paise(10_000 + t * TICK));

type Step =
  | {
      kind: "place";
      account: number;
      side: "buy" | "sell";
      type: "limit" | "market" | "stop";
      qty: number;
      price: number;
    }
  | { kind: "cancel"; account: number; pick: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("place" as const),
      account: fc.nat({ max: ACCOUNTS.length - 1 }),
      side: fc.constantFrom("buy" as const, "sell" as const),
      type: fc.constantFrom("limit" as const, "limit" as const, "market" as const, "stop" as const),
      qty: fc.integer({ min: 1, max: 300 }),
      price: priceArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("cancel" as const),
      account: fc.nat({ max: ACCOUNTS.length - 1 }),
      pick: fc.nat(),
    }),
  },
);

function toCommand(step: Step, known: readonly OrderId[]): Command {
  const accountId = ACCOUNTS[step.account] ?? "alice";
  if (step.kind === "cancel") {
    // Mostly real ids (some already closed, some owned by others), occasionally unknown.
    const orderId = known.length > 0 ? known[step.pick % known.length] : undefined;
    return { kind: "cancel", accountId, orderId: orderId ?? ("ord_0" as OrderId) };
  }
  const base = {
    kind: "place",
    accountId,
    symbol: SYMBOL,
    side: step.side,
    qty: quantity(step.qty),
  } as const;
  const price = paise(step.price);
  switch (step.type) {
    case "market":
      return { ...base, type: "market" };
    case "limit":
      return { ...base, type: "limit", limitPrice: price };
    case "stop":
      return { ...base, type: "stop", stopPrice: price };
  }
}

function checkTradePrices(
  events: readonly EngineEvent[],
  orders: ReadonlyMap<OrderId, Order>,
): void {
  for (const event of events) {
    if (event.type !== "trade") continue;
    const buy = orders.get(event.buyOrderId);
    const sell = orders.get(event.sellOrderId);
    if (buy?.type === "limit") expect(event.price).toBeLessThanOrEqual(buy.limitPrice);
    if (sell?.type === "limit") expect(event.price).toBeGreaterThanOrEqual(sell.limitPrice);
    expect(event.buyAccountId).not.toBe(event.sellAccountId);
  }
}

describe("exchange invariants under random order flow", () => {
  it("holds every invariant after every command", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 80 }), (steps) => {
        const exchange = makeExchange(ACCOUNTS);
        const known: OrderId[] = [];
        const orders = new Map<OrderId, Order>();
        const closed = new Set<OrderId>();

        for (const step of steps) {
          // Best prices before the command, to check that trades take the top of the book.
          const bestAsk = exchange.depth(SYMBOL)?.asks[0]?.price;
          const bestBid = exchange.depth(SYMBOL)?.bids[0]?.price;

          const events = exchange.submit(toCommand(step, known));

          for (const event of events) {
            if (event.type === "order.accepted") {
              known.push(event.order.id);
              orders.set(event.order.id, event.order);
            }
            if (event.type === "order.filled" || event.type === "order.cancelled") {
              expect(closed.has(event.orderId)).toBe(false); // closes exactly once
              closed.add(event.orderId);
            }
          }

          checkTradePrices(events, orders);

          // The first trade a command causes must be at the best price that was on the book.
          const first = events.find((e) => e.type === "trade");
          if (first?.type === "trade" && first.aggressor === "buy" && bestAsk !== undefined) {
            expect(first.price).toBeGreaterThanOrEqual(bestAsk);
          }
          if (first?.type === "trade" && first.aggressor === "sell" && bestBid !== undefined) {
            expect(first.price).toBeLessThanOrEqual(bestBid);
          }

          // Sequence numbers are strictly increasing.
          for (let i = 1; i < events.length; i++) {
            expect((events[i]?.seq ?? 0) > (events[i - 1]?.seq ?? 0)).toBe(true);
          }

          expect(exchange.audit()).toEqual([]);
        }

        // Every accepted order is either closed or still open — never lost.
        const open = new Set(
          ACCOUNTS.flatMap((a) => exchange.openOrders(a).map((o) => o.order.id)),
        );
        for (const id of orders.keys()) {
          expect(closed.has(id) !== open.has(id)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic: the same commands always produce the same events", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        const run = () => {
          const exchange = makeExchange(ACCOUNTS);
          const known: OrderId[] = [];
          return steps.flatMap((step) => {
            const events = exchange.submit(toCommand(step, known));
            for (const e of events) if (e.type === "order.accepted") known.push(e.order.id);
            return events;
          });
        };
        expect(run()).toEqual(run());
      }),
      { numRuns: 100 },
    );
  });
});

/** Runs steps against an exchange, tracking the order ids cancels can refer to. */
function play(exchange: Exchange, steps: readonly Step[], known: OrderId[] = []): EngineEvent[] {
  return steps.flatMap((step) => {
    const events = exchange.submit(toCommand(step, known));
    for (const e of events) if (e.type === "order.accepted") known.push(e.order.id);
    return events;
  });
}

const emptyExchange = () =>
  new Exchange([{ symbol: SYMBOL, tickSize: TICK, referencePrice: rs("100") }]);

/** A snapshot as it comes back from storage: through JSON, into a new exchange. */
function restore(state: ExchangeState): Exchange {
  const exchange = emptyExchange();
  exchange.load(JSON.parse(JSON.stringify(state)) as ExchangeState);
  return exchange;
}

const replaceAt = <T>(list: readonly T[], index: number, value: T): T[] =>
  list.map((item, i) => (i === index ? value : item));

/** Every way to change exactly one thing in a state: a counter, a price, a balance, an order. */
function singleChanges(state: ExchangeState): ExchangeState[] {
  const changes: ExchangeState[] = [{ ...state, seq: state.seq + 1 }];
  state.markets.forEach((market, m) => {
    changes.push({
      ...state,
      markets: replaceAt(state.markets, m, { ...market, lastPrice: market.lastPrice + TICK }),
    });
  });
  state.accounts.accounts.forEach((account, a) => {
    const withAccount = (next: typeof account): ExchangeState => ({
      ...state,
      accounts: { ...state.accounts, accounts: replaceAt(state.accounts.accounts, a, next) },
    });
    const [available, reserved] = account.cash;
    changes.push(withAccount({ ...account, cash: [available + 1, reserved] }));
    changes.push(withAccount({ ...account, cash: [available, reserved + 1] }));
    account.positions.forEach(([symbol, held, held2], p) => {
      changes.push(
        withAccount({
          ...account,
          positions: replaceAt(account.positions, p, [symbol, held + 1, held2]),
        }),
      );
    });
  });
  state.orders.forEach((open, o) => {
    const withOrder = (next: typeof open): ExchangeState => ({
      ...state,
      orders: replaceAt(state.orders, o, next),
    });
    changes.push(withOrder({ ...open, remaining: open.remaining + 1 }));
    // A different owner at the same place in the queue.
    const other = ACCOUNTS.find((id) => id !== open.order.accountId) ?? "alice";
    changes.push(withOrder({ ...open, order: { ...open.order, accountId: other } }));
    if (open.order.type === "limit") {
      const moved = { ...open.order, limitPrice: paise(open.order.limitPrice + TICK * 40) };
      changes.push(withOrder({ ...open, order: moved }));
    }
  });
  return changes;
}

describe("state hash and snapshots", () => {
  it("equal states hash equally: same commands, and a snapshot restored through JSON", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        const a = makeExchange(ACCOUNTS);
        const b = makeExchange(ACCOUNTS);
        play(a, steps);
        play(b, steps);
        expect(b.stateHash()).toBe(a.stateHash());

        const restored = restore(a.serialize());
        expect(restored.stateHash()).toBe(a.stateHash());
        expect(restored.serialize()).toEqual(a.serialize());
        expect(restored.audit()).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("a restored exchange behaves exactly like the original from then on", () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 50 }),
        fc.array(stepArb, { minLength: 1, maxLength: 30 }),
        (before, after) => {
          const original = makeExchange(ACCOUNTS);
          const known: OrderId[] = [];
          play(original, before, known);
          const restored = restore(original.serialize());

          expect(play(restored, after, [...known])).toEqual(play(original, after, [...known]));
          expect(restored.stateHash()).toBe(original.stateHash());
        },
      ),
      { numRuns: 200 },
    );
  });

  it("any single change to the state changes the hash", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), fc.nat(), (steps, pick) => {
        const exchange = makeExchange(ACCOUNTS);
        play(exchange, steps);
        const state = exchange.serialize();
        const changes = singleChanges(state);
        const changed = changes[pick % changes.length];
        if (!changed) return;
        expect(restore(changed).stateHash()).not.toBe(exchange.stateHash());
      }),
      { numRuns: 500 },
    );
  });

  it("every command that does anything changes the hash", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const exchange = makeExchange(ACCOUNTS);
        const known: OrderId[] = [];
        const seen = new Set([exchange.stateHash()]);
        for (const step of steps) {
          play(exchange, [step], known);
          const hash = exchange.stateHash();
          expect(seen.has(hash)).toBe(false);
          seen.add(hash);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("queue order is part of the state: the same orders in a different order hash differently", () => {
    const price = rs("99.50");
    const first = makeExchange(ACCOUNTS);
    first.submit({ ...limitBuy("alice", price) });
    first.submit({ ...limitBuy("bob", price) });
    const second = makeExchange(ACCOUNTS);
    second.submit({ ...limitBuy("bob", price) });
    second.submit({ ...limitBuy("alice", price) });
    expect(first.depth(SYMBOL)).toEqual(second.depth(SYMBOL));
    expect(first.stateHash()).not.toBe(second.stateHash());
  });

  it("refuses to load into an exchange that has already done something", () => {
    const used = makeExchange(ACCOUNTS);
    expect(() => {
      used.load(makeExchange(ACCOUNTS).serialize());
    }).toThrow(/before it has processed anything/);
  });
});

const limitBuy = (accountId: string, price: number): Command => ({
  kind: "place",
  accountId,
  symbol: SYMBOL,
  side: "buy",
  type: "limit",
  qty: quantity(10),
  limitPrice: paise(price),
});
