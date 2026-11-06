import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MoneyError, paise } from "./money.js";
import { oppositeSide } from "./order.js";
import { isOnTick, quantity, roundToTick } from "./price.js";

const price = fc.integer({ min: 0, max: 1e12 }).map(paise);
const tick = fc.integer({ min: 1, max: 10_000 }).map(paise);

describe("roundToTick()", () => {
  it.each([
    [1003, 5, "down", 1000],
    [1003, 5, "up", 1005],
    [1002, 5, "nearest", 1000],
    [1003, 5, "nearest", 1005],
    [1000, 5, "up", 1000],
  ] as const)("rounds %i to tick %i (%s) as %i", (p, t, mode, expected) => {
    expect(roundToTick(paise(p), paise(t), mode)).toBe(expected);
  });

  it("always lands on the grid, in the requested direction", () => {
    fc.assert(
      fc.property(price, tick, (p, t) => {
        const down = roundToTick(p, t, "down");
        const up = roundToTick(p, t, "up");
        const nearest = roundToTick(p, t, "nearest");

        for (const rounded of [down, up, nearest]) expect(isOnTick(rounded, t)).toBe(true);
        expect(down).toBeLessThanOrEqual(p);
        expect(up).toBeGreaterThanOrEqual(p);
        expect(up - down).toBeLessThanOrEqual(t);
        expect(Math.abs(nearest - p) * 2).toBeLessThanOrEqual(t);
      }),
    );
  });

  it("leaves on-tick prices unchanged", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e8 }), tick, (steps, t) => {
        const onTick = paise(steps * t);
        expect(roundToTick(onTick, t, "up")).toBe(onTick);
        expect(roundToTick(onTick, t, "down")).toBe(onTick);
      }),
    );
  });

  it("rejects a non-positive tick or a negative price", () => {
    expect(() => roundToTick(paise(100), paise(0))).toThrow(MoneyError);
    expect(() => roundToTick(paise(-5), paise(5))).toThrow(MoneyError);
  });
});

describe("quantity()", () => {
  it.each([0, -1, 1.5, NaN])("rejects %s", (value) => {
    expect(() => quantity(value)).toThrow(MoneyError);
  });

  it("accepts positive integers", () => {
    expect(quantity(25)).toBe(25);
  });
});

describe("oppositeSide()", () => {
  it("swaps buy and sell", () => {
    expect(oppositeSide("buy")).toBe("sell");
    expect(oppositeSide("sell")).toBe("buy");
  });
});
