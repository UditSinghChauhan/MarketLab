import { describe, expect, it } from "vitest";

import { changeTone, duration, pct, price, rupees, signedRupees, stepPrice } from "./format";

describe("format", () => {
  it.each([
    ["0", "0.00"],
    ["5.5", "5.50"],
    ["1234567.05", "12,34,567.05"],
    ["-12.5", "−12.50"],
  ])("price(%j) uses Indian grouping and two decimals", (input, expected) => {
    expect(price(input)).toBe(expected);
  });

  it("renders missing values as a dash", () => {
    expect(price(null)).toBe("—");
    expect(rupees(undefined)).toBe("—");
  });

  it("signs rupee changes and percentages", () => {
    expect(signedRupees("12.5")).toBe("+₹12.50");
    expect(signedRupees("-3")).toBe("−₹3.00");
    expect(signedRupees("0.00")).toBe("₹0.00");
    expect(pct(1.234)).toBe("+1.23%");
    expect(pct(-0.5)).toBe("−0.50%");
    expect(pct(0)).toBe("0.00%");
  });

  it("colours flat changes as neutral", () => {
    expect(changeTone(0)).toBe("text-muted");
    expect(changeTone("0.00")).toBe("text-muted");
    expect(changeTone(0.1)).toBe("text-bid");
    expect(changeTone("-1")).toBe("text-ask");
  });

  it("steps prices by whole ticks without float drift", () => {
    expect(stepPrice("0.10", "0.05", 1)).toBe("0.15");
    expect(stepPrice("1250.00", "0.05", -3)).toBe("1249.85");
    // 0.1 + 0.2 style drift would show up here after many steps.
    let p = "100.00";
    for (let i = 0; i < 1000; i++) p = stepPrice(p, "0.05", 1);
    expect(p).toBe("150.00");
    expect(stepPrice("0.05", "0.05", -5)).toBe("0.05"); // never below one tick
  });

  it("formats durations at a sensible unit", () => {
    expect(duration(0.6)).toBe("0.6 µs");
    expect(duration(58)).toBe("58 µs");
    expect(duration(3140)).toBe("3.14 ms");
  });
});
