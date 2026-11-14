/** Engine vocabulary turned into words a trader understands. */

import type { EventView, OrderType, OrderView, Side } from "@marketlab/contracts";

import { price, qty, rupees } from "./format";

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
