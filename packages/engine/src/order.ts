/**
 * Order model shared by the matching engine (Phase 1) and the API (Phase 3).
 *
 * Orders are a discriminated union on `type`, so a limit order without a limit
 * price, or a market order with one, does not type-check.
 */

import type { Paise } from "./money.js";
import type { Quantity } from "./price.js";

export type Side = "buy" | "sell";

export function oppositeSide(side: Side): Side {
  return side === "buy" ? "sell" : "buy";
}

declare const orderIdBrand: unique symbol;
export type OrderId = string & { readonly [orderIdBrand]: true };

interface OrderBase {
  readonly id: OrderId;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: Quantity;
  /**
   * Monotonic arrival sequence assigned by the engine. Time priority is decided
   * by this number, never by wall-clock timestamps, so matching is deterministic.
   */
  readonly seq: number;
}

/** Fills immediately against the book at the best available prices. */
export interface MarketOrder extends OrderBase {
  readonly type: "market";
}

/** Rests in the book until matched at `limitPrice` or better. */
export interface LimitOrder extends OrderBase {
  readonly type: "limit";
  readonly limitPrice: Paise;
}

/** Becomes a market order once the last trade price reaches `stopPrice`. */
export interface StopOrder extends OrderBase {
  readonly type: "stop";
  readonly stopPrice: Paise;
}

export type Order = MarketOrder | LimitOrder | StopOrder;
export type OrderType = Order["type"];
