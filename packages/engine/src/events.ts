/**
 * The engine's interface: commands in, events out.
 *
 * `Exchange.submit(command)` returns the events that command caused, in order.
 * Events carry a global sequence number and no wall-clock time, so the same
 * commands always produce the same events. The API layer adds timestamps,
 * persists events and streams them to clients; the engine inspector in the UI
 * is a view over exactly this stream.
 */

import type { Paise } from "./money.js";
import type { Order, OrderId, Side } from "./order.js";
import type { Quantity } from "./price.js";

interface PlaceBase {
  readonly kind: "place";
  readonly accountId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: Quantity;
  /**
   * The client's own id for this order (a UUID), so a retry of the same
   * request can be recognised. The exchange remembers the last
   * `CLIENT_ORDER_IDS_PER_ACCOUNT` per account and what became of each.
   */
  readonly clientOrderId?: string;
}

export type PlaceCommand =
  | (PlaceBase & { readonly type: "market" })
  | (PlaceBase & { readonly type: "limit"; readonly limitPrice: Paise })
  | (PlaceBase & { readonly type: "stop"; readonly stopPrice: Paise });

export interface CancelCommand {
  readonly kind: "cancel";
  readonly accountId: string;
  readonly orderId: OrderId;
}

export type Command = PlaceCommand | CancelCommand;

export type RejectReason =
  | "unknown_account"
  | "unknown_symbol"
  | "invalid_quantity"
  | "invalid_price"
  | "off_tick"
  | "insufficient_funds"
  | "insufficient_shares"
  | "unknown_order"
  | "not_owner";

export type CancelReason =
  /** The owner cancelled it. */
  | "user"
  /** A market order found no more liquidity; the rest is cancelled, never rested. */
  | "no_liquidity"
  /** A market buy ran out of cash part-way through the book. */
  | "insufficient_funds"
  /** The incoming order would have traded with the same account's resting order. */
  | "self_trade";

export type EngineEvent =
  | { readonly type: "order.accepted"; readonly seq: number; readonly order: Order }
  | {
      readonly type: "order.rejected";
      readonly seq: number;
      readonly reason: RejectReason;
      readonly command: Command;
    }
  | {
      readonly type: "trade";
      readonly seq: number;
      readonly symbol: string;
      readonly price: Paise;
      readonly qty: number;
      readonly buyOrderId: OrderId;
      readonly sellOrderId: OrderId;
      readonly buyAccountId: string;
      readonly sellAccountId: string;
      /** The side of the incoming order that took liquidity. */
      readonly aggressor: Side;
    }
  | {
      readonly type: "order.rested";
      readonly seq: number;
      readonly orderId: OrderId;
      readonly symbol: string;
      readonly side: Side;
      readonly price: Paise;
      readonly remaining: number;
    }
  | { readonly type: "order.filled"; readonly seq: number; readonly orderId: OrderId }
  | {
      readonly type: "order.cancelled";
      readonly seq: number;
      readonly orderId: OrderId;
      readonly remaining: number;
      readonly reason: CancelReason;
    }
  | {
      readonly type: "stop.triggered";
      readonly seq: number;
      readonly orderId: OrderId;
      readonly lastPrice: Paise;
    };

export type EngineEventType = EngineEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the exchange stamps its sequence number. */
export type UnsequencedEvent = DistributiveOmit<EngineEvent, "seq">;
