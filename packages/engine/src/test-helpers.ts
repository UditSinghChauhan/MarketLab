/** Shared fixtures for engine tests. Not exported from the package. */

import type { EngineEvent, PlaceCommand } from "./events.js";
import { Exchange } from "./exchange.js";
import { paise, parseRupees, type Paise } from "./money.js";
import type { OrderId, Side } from "./order.js";
import { quantity } from "./price.js";

export const SYMBOL = "ACME";
export const TICK = paise(5);
/** ₹1,00,000 per account. */
export const START_CASH = parseRupees("100000");
export const START_SHARES = 1_000;

/** Rupee price helper: rs("100.05") → 10005 paise. */
export const rs = (value: string): Paise => parseRupees(value);

export function makeExchange(accounts: readonly string[] = ["alice", "bob", "carol"]): Exchange {
  const exchange = new Exchange([{ symbol: SYMBOL, tickSize: TICK, referencePrice: rs("100") }]);
  for (const id of accounts) exchange.accounts.open(id, START_CASH, { [SYMBOL]: START_SHARES });
  return exchange;
}

export const limit = (accountId: string, side: Side, qty: number, price: Paise): PlaceCommand => ({
  kind: "place",
  accountId,
  symbol: SYMBOL,
  side,
  type: "limit",
  qty: quantity(qty),
  limitPrice: price,
});

export const market = (accountId: string, side: Side, qty: number): PlaceCommand => ({
  kind: "place",
  accountId,
  symbol: SYMBOL,
  side,
  type: "market",
  qty: quantity(qty),
});

export const stop = (accountId: string, side: Side, qty: number, price: Paise): PlaceCommand => ({
  kind: "place",
  accountId,
  symbol: SYMBOL,
  side,
  type: "stop",
  qty: quantity(qty),
  stopPrice: price,
});

export type Of<T extends EngineEvent["type"]> = Extract<EngineEvent, { type: T }>;

export function ofType<T extends EngineEvent["type"]>(events: EngineEvent[], type: T): Of<T>[] {
  return events.filter((e): e is Of<T> => e.type === type);
}

export function acceptedId(events: EngineEvent[]): OrderId {
  const accepted = ofType(events, "order.accepted")[0];
  if (!accepted) throw new Error(`No order.accepted in ${JSON.stringify(events)}`);
  return accepted.order.id;
}
