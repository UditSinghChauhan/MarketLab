/** Engine vocabulary turned into words a trader understands. */

import type { CommandResult, EventView, OrderType, OrderView, Side } from "@marketlab/contracts";

import { ApiRequestError } from "./api";
import { price, qty, rupees } from "./format";

/**
 * A new client order id (a version 4 UUID). `crypto.randomUUID` needs a
 * secure context; `getRandomValues` works everywhere.
 */
export function newClientOrderId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * True when an order request failed without saying whether the order was
 * placed: no response at all, a server error (the write may have reached the
 * log before the reply was lost), or a success status with a body that is not
 * a command result (`UnexpectedResponseError`). A 4xx means it was not placed.
 */
export function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || error.status >= 500;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isStringOrNull = (value: unknown) => value === null || typeof value === "string";

/**
 * True when an order response body has the shape of a `CommandResult`: enough
 * to read its outcome and show it, so a truncated or empty body is never
 * mistaken for a handled order.
 */
export function isCommandResult(body: unknown): body is CommandResult {
  return (
    isObject(body) &&
    typeof body.ok === "boolean" &&
    isStringOrNull(body.orderId) &&
    isStringOrNull(body.rejectReason) &&
    Array.isArray(body.events) &&
    isObject(body.timing) &&
    (body.replayed === undefined || body.replayed === true) &&
    (body.order === undefined || body.order === null || isObject(body.order))
  );
}

export const UNCONFIRMED_ORDER =
  "Couldn't confirm this order. It may have been placed: check Orders before placing it again. Resending it unchanged from this ticket won't place it twice, but after a reload or a market switch it would.";

/** The answer to a retry the exchange recognised: what the first attempt did. */
export function replayedMessage(result: CommandResult): string {
  if (!result.ok) return rejectMessage(result.rejectReason);
  // `order` is null once the order has left the account's order history; the
  // first attempt was still accepted, and this retry still placed nothing.
  const status = result.order ? ` (${statusLabel(result.order).toLowerCase()})` : "";
  return `Your earlier attempt already placed this order${status}. It wasn't placed twice.`;
}

const REJECT_REASONS: Record<string, string> = {
  insufficient_funds: "Not enough cash for this order.",
  insufficient_shares: "You don't hold enough shares to sell that many.",
  off_tick: "Prices move in steps of ₹0.05. Round the price to the nearest step.",
  invalid_price: "Enter a price above zero.",
  invalid_quantity: "Enter a whole number of shares.",
  unknown_symbol: "That market doesn't exist.",
  unknown_order: "That order is no longer open.",
  unknown_account: "Your session has ended. Reload to start a new one.",
  not_owner: "That order is no longer open.",
};

const CANCEL_REASONS: Record<string, string> = {
  user: "Cancelled by you",
  no_liquidity: "Rest cancelled: no more sellers or buyers in the book",
  insufficient_funds: "Rest cancelled: cash ran out part-way",
  self_trade: "Cancelled to avoid trading with your own order",
};

export function rejectMessage(reason: string | null): string {
  return (reason && REJECT_REASONS[reason]) ?? "The exchange rejected this order.";
}

export function cancelMessage(reason: string | null): string {
  return (reason && CANCEL_REASONS[reason]) ?? "Cancelled";
}

export const sideLabel = (side: Side): string => (side === "buy" ? "Buy" : "Sell");

export const typeLabel = (type: OrderType): string =>
  type === "market" ? "Market" : type === "limit" ? "Limit" : "Stop";

export function statusLabel(order: OrderView): string {
  switch (order.status) {
    case "pending_stop":
      return "Waiting for stop";
    case "resting":
      return order.filled > 0 ? "Partly filled" : "In the book";
    case "filled":
      return "Filled";
    case "cancelled":
      return order.filled > 0 ? "Partly filled, rest cancelled" : "Cancelled";
  }
}

/** One line per engine event, for the inspector timeline. */
export function describeEvent(
  event: EventView,
  orderId: string,
): { title: string; detail: string } {
  switch (event.type) {
    case "order.accepted":
      return {
        title: "Accepted",
        detail: `${sideLabel(event.side)} ${qty(event.qty)} ${event.symbol}, ${typeLabel(event.orderType).toLowerCase()}${
          event.price
            ? ` at ${rupees(event.price)}`
            : event.stopPrice
              ? `, stop ${rupees(event.stopPrice)}`
              : ""
        }. Funds reserved.`,
      };
    case "order.rejected":
      return { title: "Rejected", detail: rejectMessage(event.reason) };
    case "trade": {
      const mine = event.buyOrderId === orderId ? "bought" : "sold";
      const other = event.buyOrderId === orderId ? event.sellOrderId : event.buyOrderId;
      return {
        title: "Matched",
        detail: `${qty(event.qty)} ${mine} at ₹${price(event.price)} against ${other}.`,
      };
    }
    case "order.rested":
      return {
        title: "Resting in the book",
        detail: `${qty(event.remaining)} waiting at ₹${price(event.price)}, behind earlier orders at that price.`,
      };
    case "order.filled":
      return { title: "Filled", detail: "Nothing left to trade." };
    case "order.cancelled":
      return {
        title: "Cancelled",
        detail: `${cancelMessage(event.reason)}. ${qty(event.remaining)} unfilled.`,
      };
    case "stop.triggered":
      return {
        title: "Stop triggered",
        detail: `Last trade reached ₹${price(event.lastPrice)}; now executing as a market order.`,
      };
  }
}

/** Short confirmation for a toast after the user's own order changes. */
export function confirmation(events: readonly EventView[]): string | null {
  const accepted = events.find((e) => e.type === "order.accepted");
  const trades = events.filter(
    (e): e is Extract<EventView, { type: "trade" }> => e.type === "trade",
  );
  if (accepted?.type === "order.accepted" && trades.length > 0) {
    const filled = trades.reduce((n, t) => n + t.qty, 0);
    return `${accepted.side === "buy" ? "Bought" : "Sold"} ${qty(filled)} ${accepted.symbol}`;
  }
  if (accepted?.type === "order.accepted") {
    return accepted.orderType === "stop"
      ? `Stop order placed for ${accepted.symbol}`
      : `Limit order placed for ${accepted.symbol}`;
  }
  return null;
}
