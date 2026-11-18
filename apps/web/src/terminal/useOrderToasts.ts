import type { EventView, OrderView } from "@marketlab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { price, qty } from "../lib/format";
import { sideLabel } from "../lib/orders";

export interface Toast {
  id: number;
  text: string;
  tone: "ok" | "info";
}

/**
 * Toasts for things that happen to the user's orders while they look
 * elsewhere: a resting order filling, a stop firing. Events the user just
 * caused are confirmed where they acted; `markOwn` keeps them out of here.
 */
export function useOrderToasts(
  lastOrderEvents: readonly EventView[],
  orders: readonly OrderView[],
) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const ownSeqs = useRef(new Set<number>());

  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4_000);
  }, []);

  const markOwn = useCallback((events: readonly EventView[]) => {
    for (const e of events) ownSeqs.current.add(e.seq);
  }, []);

  // Orders are read through a ref so a refreshed order list doesn't replay old toasts.
  const ordersRef = useRef(orders);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);
  useEffect(() => {
    const later = lastOrderEvents.filter((e) => !ownSeqs.current.has(e.seq));
    for (const event of later) {
      const message = describeAsync(event, ordersRef.current);
      if (message) toast(message);
    }
  }, [lastOrderEvents, toast]);

  return { toasts, toast, markOwn };
}

/** Messages for changes the user didn't just cause: a resting order filling, a stop firing. */
function describeAsync(event: EventView, orders: readonly OrderView[]): string | null {
  const order = (id: string) => orders.find((o) => o.id === id);
  if (event.type === "order.filled") {
    const o = order(event.orderId);
    // An order missing from the list was placed a moment ago; its ticket already confirmed it.
    return o ? `${sideLabel(o.side)} ${qty(o.qty)} ${o.symbol} filled` : null;
  }
  if (event.type === "stop.triggered") {
    const o = order(event.orderId);
    return `Stop ${o ? `${sideLabel(o.side).toLowerCase()} ${o.symbol} ` : ""}triggered at ₹${price(event.lastPrice)}`;
  }
  return null;
}
