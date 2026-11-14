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
import { paise } from "./money.js";
import type { Order, OrderId } from "./order.js";
import { quantity } from "./price.js";
import { SYMBOL, TICK, makeExchange } from "./test-helpers.js";

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
