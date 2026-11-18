import type { EventView, OrderView } from "@marketlab/contracts";
import { describe, expect, it } from "vitest";

import {
  cancelMessage,
  confirmation,
  describeEvent,
  rejectMessage,
  sideLabel,
  statusLabel,
  typeLabel,
} from "./orders";

const at = { seq: 1, at: 0 };
const accepted = (
  overrides: Partial<Extract<EventView, { type: "order.accepted" }>> = {},
): EventView => ({
  ...at,
  type: "order.accepted",
  orderId: "o1",
  symbol: "ORBT",
  side: "buy",
  orderType: "limit",
  qty: 10,
  price: "1250.00",
  stopPrice: null,
  ...overrides,
});
const trade = (qty: number, buyOrderId = "o1", sellOrderId = "o2"): EventView => ({
  ...at,
  type: "trade",
  symbol: "ORBT",
  price: "1250.05",
  qty,
  buyOrderId,
  sellOrderId,
  aggressor: "buy",
});
const order = (status: OrderView["status"], filled: number): OrderView => ({
  id: "o1",
  symbol: "ORBT",
  side: "buy",
  type: "limit",
  qty: 10,
  filled,
  remaining: 10 - filled,
  price: "1250.00",
  stopPrice: null,
  avgFillPrice: null,
  status,
  reason: null,
  createdAt: 0,
  updatedAt: 0,
});

describe("reason messages", () => {
  it("explains known reasons and falls back for unknown or missing ones", () => {
    expect(rejectMessage("off_tick")).toBe(
      "Prices move in steps of ₹0.05. Round the price to the nearest step.",
    );
    expect(rejectMessage("something_new")).toBe("The exchange rejected this order.");
    expect(rejectMessage(null)).toBe("The exchange rejected this order.");
    expect(cancelMessage("self_trade")).toBe("Cancelled to avoid trading with your own order");
    expect(cancelMessage("something_new")).toBe("Cancelled");
    expect(cancelMessage(null)).toBe("Cancelled");
  });
});

describe("labels", () => {
  it("names sides and order types", () => {
    expect([sideLabel("buy"), sideLabel("sell")]).toEqual(["Buy", "Sell"]);
    expect([typeLabel("market"), typeLabel("limit"), typeLabel("stop")]).toEqual([
      "Market",
      "Limit",
      "Stop",
    ]);
  });

  it("tells a partly filled order from an untouched one", () => {
    expect(statusLabel(order("pending_stop", 0))).toBe("Waiting for stop");
    expect(statusLabel(order("resting", 0))).toBe("In the book");
    expect(statusLabel(order("resting", 4))).toBe("Partly filled");
    expect(statusLabel(order("filled", 10))).toBe("Filled");
    expect(statusLabel(order("cancelled", 0))).toBe("Cancelled");
    expect(statusLabel(order("cancelled", 4))).toBe("Partly filled, rest cancelled");
  });
});

describe("describeEvent", () => {
  it("describes an accepted order with its limit price, its stop price, or neither", () => {
    expect(describeEvent(accepted(), "o1")).toEqual({
      title: "Accepted",
      detail: "Buy 10 ORBT, limit at ₹1,250.00. Funds reserved.",
    });
    expect(
      describeEvent(
        accepted({ side: "sell", orderType: "stop", price: null, stopPrice: "1200.00" }),
        "o1",
      ).detail,
    ).toBe("Sell 10 ORBT, stop, stop ₹1,200.00. Funds reserved.");
    expect(
      describeEvent(accepted({ orderType: "market", price: null, qty: 1500 }), "o1").detail,
    ).toBe("Buy 1,500 ORBT, market. Funds reserved.");
  });

  it("describes a trade from this order's side and names the counterparty order", () => {
    expect(describeEvent(trade(4, "o1", "o2"), "o1")).toEqual({
      title: "Matched",
      detail: "4 bought at ₹1,250.05 against o2.",
    });
    expect(describeEvent(trade(4, "o9", "o1"), "o1").detail).toBe(
      "4 sold at ₹1,250.05 against o9.",
    );
  });

  it("describes rejection, resting, fill, cancellation and a triggered stop", () => {
    const events: [EventView, string, string][] = [
      [
        { ...at, type: "order.rejected", reason: "insufficient_funds" },
        "Rejected",
        "Not enough cash for this order.",
      ],
      [
        { ...at, type: "order.rested", orderId: "o1", price: "1250.00", remaining: 6 },
        "Resting in the book",
        "6 waiting at ₹1,250.00, behind earlier orders at that price.",
      ],
      [{ ...at, type: "order.filled", orderId: "o1" }, "Filled", "Nothing left to trade."],
      [
        { ...at, type: "order.cancelled", orderId: "o1", remaining: 6, reason: "user" },
        "Cancelled",
        "Cancelled by you. 6 unfilled.",
      ],
      [
        { ...at, type: "stop.triggered", orderId: "o1", lastPrice: "1199.95" },
        "Stop triggered",
        "Last trade reached ₹1,199.95; now executing as a market order.",
      ],
    ];
    for (const [event, title, detail] of events) {
      expect(describeEvent(event, "o1")).toEqual({ title, detail });
    }
  });
});

describe("confirmation", () => {
  it("sums the fills of an order that traded", () => {
    expect(confirmation([accepted(), trade(4), trade(6)])).toBe("Bought 10 ORBT");
    expect(confirmation([accepted({ side: "sell" }), trade(3, "o2", "o1")])).toBe("Sold 3 ORBT");
  });

  it("confirms a resting limit or a waiting stop", () => {
    expect(confirmation([accepted()])).toBe("Limit order placed for ORBT");
    expect(confirmation([accepted({ orderType: "stop", price: null, stopPrice: "1.00" })])).toBe(
      "Stop order placed for ORBT",
    );
  });

  it("has nothing to say without an accepted order", () => {
    expect(confirmation([])).toBeNull();
    expect(confirmation([{ ...at, type: "order.rejected", reason: "off_tick" }])).toBeNull();
  });
});
