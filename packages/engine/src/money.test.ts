import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MoneyError,
  add,
  compare,
  formatRupees,
  negate,
  notional,
  paise,
  parseRupees,
  subtract,
  toDecimalString,
} from "./money.js";

// Amounts well inside the safe range so sums of two never overflow.
const amount = fc.integer({ min: -1e13, max: 1e13 }).map(paise);

describe("paise()", () => {
  it.each([0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects %s", (value) => {
    expect(() => paise(value)).toThrow(MoneyError);
  });

  it("accepts safe integers", () => {
    expect(paise(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(paise(-42)).toBe(-42);
  });
});

describe("arithmetic", () => {
  it("is exact where floats are not", () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in paise it is exact.
    expect(add(parseRupees("0.10"), parseRupees("0.20"))).toBe(parseRupees("0.30"));
  });

  it("subtract undoes add", () => {
    fc.assert(fc.property(amount, amount, (a, b) => subtract(add(a, b), b) === a));
  });

  it("add is commutative and associative", () => {
    fc.assert(
      fc.property(amount, amount, amount, (a, b, c) => {
        expect(add(a, b)).toBe(add(b, a));
        expect(add(add(a, b), c)).toBe(add(a, add(b, c)));
      }),
    );
  });

  it("negate is its own inverse and sums to zero", () => {
    fc.assert(
      fc.property(amount, (a) => {
        expect(negate(negate(a))).toBe(a);
        expect(add(a, negate(a)) === 0).toBe(true);
      }),
    );
  });

  it("compare orders amounts", () => {
    expect(compare(paise(1), paise(2))).toBe(-1);
    expect(compare(paise(2), paise(2))).toBe(0);
    expect(compare(paise(3), paise(2))).toBe(1);
  });

  it("throws instead of losing precision on overflow", () => {
    expect(() => add(paise(Number.MAX_SAFE_INTEGER), paise(1))).toThrow(MoneyError);
  });
});

describe("notional()", () => {
  it("multiplies price by quantity", () => {
    expect(notional(parseRupees("1555.45"), 10)).toBe(parseRupees("15554.50"));
  });

  it("rejects fractional or negative quantities", () => {
    expect(() => notional(paise(100), 1.5)).toThrow(MoneyError);
    expect(() => notional(paise(100), -1)).toThrow(MoneyError);
  });

  it("rejects results beyond the safe integer range", () => {
    expect(() => notional(paise(Number.MAX_SAFE_INTEGER), 2)).toThrow(MoneyError);
  });
});

describe("parseRupees()", () => {
  it.each([
    ["0", 0],
    ["12", 1200],
    ["12.5", 1250],
    ["12.05", 1205],
    ["-0.05", -5],
    ["-0", 0],
    [" 7.00 ", 700],
  ])("parses %j as %i paise", (input, expected) => {
    expect(parseRupees(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "1,000", "₹10", "1e3", ".5", "--1"])("rejects %j", (input) => {
    expect(() => parseRupees(input)).toThrow(MoneyError);
  });

  it("round-trips with toDecimalString", () => {
    fc.assert(fc.property(amount, (a) => parseRupees(toDecimalString(a)) === a));
  });
});

describe("formatRupees()", () => {
  it.each([
    [0, "₹0.00"],
    [5, "₹0.05"],
    [123450, "₹1,234.50"],
    [10000000, "₹1,00,000.00"],
    [1234567890, "₹1,23,45,678.90"],
    [-5, "-₹0.05"],
  ])("formats %i paise as %s", (value, expected) => {
    expect(formatRupees(paise(value))).toBe(expected);
  });
});
