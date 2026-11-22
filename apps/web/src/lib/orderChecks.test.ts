import { PlaceOrderRequest } from "@marketlab/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { checkOrder, type OrderContext, type OrderDraft } from "./orderChecks";

const context: OrderContext = {
  symbol: "ORBT",
  tick: "0.05",
  marketPrice: "1250.05",
  cash: "1000000.00",
  sellable: 40,
};

const buy = (draft: Partial<OrderDraft> = {}, ctx: Partial<OrderContext> = {}) =>
  checkOrder(
    { side: "buy", type: "limit", qty: "10", price: "1250.00", ...draft },
    {
      ...context,
      ...ctx,
    },
  );

describe("checkOrder", () => {
  it("accepts a valid order and estimates it exactly, in paise", () => {
    expect(buy()).toEqual({
      ok: true,
      qty: null,
      price: null,
      shares: 10,
      estimate: "12500.00",
    });
    expect(buy({ type: "market" }).estimate).toBe("12500.50");
    // 3 × 0.10 is 0.30000000000000004 in floats.
    expect(buy({ qty: "3", price: "0.10" }).estimate).toBe("0.30");
  });

  describe("quantity", () => {
    it.each([
      ["", "hint", "Enter a number of shares."],
      ["0", "error", "Enter at least 1 share."],
      ["1.5", "error", "Enter a whole number of shares."],
      ["100001", "error", "One order can be at most 1,00,000 shares."],
    ])("%j → %s %j", (qty, tone, text) => {
      const check = buy({ qty });
      expect(check.ok).toBe(false);
      expect(check.qty).toEqual({ tone, text });
      expect(check.shares).toBeNull();
    });

    it("accepts 1 and 1,00,000 exactly", () => {
      expect(buy({ qty: "1", price: "1.00" }).ok).toBe(true);
      expect(buy({ qty: "100000", price: "1.00" }).ok).toBe(true);
    });
  });

  describe("price", () => {
    it("names the two valid prices either side of an off-tick price, formatted", () => {
      expect(buy({ price: "1250.07" }).price).toEqual({
        tone: "error",
        text: "Prices move in steps of ₹0.05. The nearest are ₹1,250.05 and ₹1,250.10.",
      });
      // Typed or pasted with more decimals than the exchange takes.
      expect(buy({ price: "125000.123" }).price?.text).toBe(
        "Prices move in steps of ₹0.05. The nearest are ₹1,25,000.10 and ₹1,25,000.15.",
      );
    });

    it("offers only the lowest price when the one below would be zero", () => {
      expect(buy({ price: "0.02" }).price?.text).toBe(
        "Prices move in steps of ₹0.05. The lowest is ₹0.05.",
      );
    });

    it("rejects zero, malformed and over-precise prices", () => {
      expect(buy({ price: "0.00" }).price).toEqual({
        tone: "error",
        text: "Enter a price above zero.",
      });
      expect(buy({ price: "1.2.3" }).price).toEqual({
        tone: "error",
        text: "Enter a price like ₹1,250.05.",
      });
      expect(buy({ price: "1250.050" }).price?.text).toBe("Use two decimals: ₹1,250.05.");
    });

    it("treats an empty price, or one still being typed, as a hint", () => {
      expect(buy({ price: "" }).price).toEqual({ tone: "hint", text: "Enter a limit price." });
      expect(buy({ type: "stop", price: "" }).price?.text).toBe("Enter a stop price.");
      expect(buy({ price: "1250." }).price?.tone).toBe("hint");
    });

    it("ignores the price field for a market order", () => {
      expect(buy({ type: "market", price: "nonsense" }).ok).toBe(true);
    });
  });

  describe("cash", () => {
    it("blocks a buy that costs more than the available cash, and says how many fit", () => {
      const check = buy({ qty: "1000" });
      expect(check.ok).toBe(false);
      expect(check.qty?.text).toBe(
        "That costs ₹12,50,000.00, more than your ₹10,00,000.00 cash. Up to 800 shares fit.",
      );
      expect(buy({ qty: "800" }).ok).toBe(true); // exactly the cash
    });

    it("estimates a market buy at the best ask, and says so", () => {
      expect(buy({ type: "market", qty: "1000" }).qty?.text).toMatch(
        /^That costs about ₹12,50,050\.00, .* Up to 799 shares fit\.$/,
      );
    });

    it("says when not even one share fits", () => {
      expect(buy({ qty: "1" }, { cash: "100.00" }).qty?.text).toMatch(
        /Not enough for one share\.$/,
      );
    });

    it("does not check a sell, or an account not yet loaded", () => {
      expect(buy({ side: "sell", qty: "5" }, { cash: "0.00" }).ok).toBe(true);
      expect(buy({ qty: "1000" }, { cash: null }).ok).toBe(true);
    });
  });

  describe("shares held", () => {
    it("blocks selling more than can be sold", () => {
      expect(buy({ side: "sell", qty: "41" }).qty?.text).toBe("You can sell up to 40 ORBT.");
      expect(buy({ side: "sell", qty: "1" }, { sellable: 0 }).qty?.text).toBe(
        "You have no ORBT to sell.",
      );
      expect(buy({ side: "sell", qty: "40" }).ok).toBe(true);
      expect(buy({ side: "sell", qty: "41" }, { sellable: null }).ok).toBe(true);
    });

    it("formats large holdings with the app's grouping", () => {
      expect(buy({ side: "sell", qty: "100000" }, { sellable: 12_345 }).qty?.text).toBe(
        "You can sell up to 12,345 ORBT.",
      );
    });
  });

  it("agrees with the shared contract: what it accepts, the API's schema accepts", () => {
    // What the fields can hold: the shares field keeps digits, the price fields digits and dots.
    const typedQty = fc.stringMatching(/^\d{0,7}$/);
    const typedPrice = fc.oneof(
      fc.stringMatching(/^\d{0,14}(\.\d{0,4})?$/),
      fc.stringMatching(/^[\d.]{0,10}$/),
    );
    fc.assert(
      fc.property(
        fc.constantFrom("market", "limit", "stop" as const),
        fc.constantFrom("buy", "sell" as const),
        typedQty,
        typedPrice,
        (type, side, qty, price) => {
          const check = checkOrder(
            { side, type, qty, price },
            { ...context, cash: null, sellable: null },
          );
          const parsed = PlaceOrderRequest.safeParse({
            symbol: "ORBT",
            side,
            type,
            qty: Number(qty),
            ...(type === "limit" ? { price } : type === "stop" ? { stopPrice: price } : {}),
          });
          if (check.ok) expect(parsed.success).toBe(true);
          // The only orders the schema takes and these checks refuse are the
          // engine's own rejections: a zero or off-tick price.
          if (parsed.success && !check.ok) {
            expect(type).not.toBe("market");
            expect(check.price?.text).toMatch(/above zero|steps of/);
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
