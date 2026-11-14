/** Conversions between engine values (integer paise) and wire values (decimal strings). */

import type { EventView } from "@marketlab/contracts";
import { paise, toDecimalString, type EngineEvent } from "@marketlab/engine";

export const rupees = (amount: number): string => toDecimalString(paise(amount));

export function toEventView(event: EngineEvent, at: number): EventView {
  const base = { seq: event.seq, at };
  switch (event.type) {
    case "order.accepted": {
      const { order } = event;
      return {
        ...base,
        type: event.type,
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        orderType: order.type,
        qty: order.qty,
        price: order.type === "limit" ? rupees(order.limitPrice) : null,
        stopPrice: order.type === "stop" ? rupees(order.stopPrice) : null,
      };
    }
    case "order.rejected":
      return { ...base, type: event.type, reason: event.reason };
    case "trade":
      return {
        ...base,
        type: event.type,
        symbol: event.symbol,
        price: rupees(event.price),
        qty: event.qty,
        buyOrderId: event.buyOrderId,
        sellOrderId: event.sellOrderId,
        aggressor: event.aggressor,
      };
    case "order.rested":
      return {
        ...base,
        type: event.type,
        orderId: event.orderId,
        price: rupees(event.price),
        remaining: event.remaining,
      };
    case "order.filled":
      return { ...base, type: event.type, orderId: event.orderId };
    case "order.cancelled":
      return {
        ...base,
        type: event.type,
        orderId: event.orderId,
        remaining: event.remaining,
        reason: event.reason,
      };
    case "stop.triggered":
      return {
        ...base,
        type: event.type,
        orderId: event.orderId,
        lastPrice: rupees(event.lastPrice),
      };
  }
}
