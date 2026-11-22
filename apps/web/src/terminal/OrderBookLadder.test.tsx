// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { OrderBook } from "@marketlab/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrderBookLadder } from "./OrderBookLadder";

const book: OrderBook = {
  symbol: "ORBT",
  seq: 1,
  asks: [
    { price: "1223.25", qty: 65, orders: 2 },
    { price: "1223.30", qty: 1, orders: 1 },
    { price: "1223.35", qty: 601, orders: 3 },
  ],
  bids: [
    { price: "1223.10", qty: 40, orders: 1 },
    { price: "1223.05", qty: 12, orders: 1 },
  ],
  spread: "0.15",
  mid: "1223.17",
};

function setup(myPrices = { buy: new Set<string>(), sell: new Set<string>() }) {
  const onPick = vi.fn();
  render(
    <>
      <button type="button">Before</button>
      <OrderBookLadder book={book} myPrices={myPrices} onPick={onPick} />
      <button type="button">After</button>
    </>,
  );
  return { onPick, user: userEvent.setup() };
}

const row = (name: string | RegExp) => screen.getByRole("button", { name });

afterEach(cleanup);

describe("OrderBookLadder", () => {
  it("labels every level in words: side, price, shares, total, and what a click does", () => {
    setup();
    expect(row("Ask ₹1,223.25, 65 shares, 65 total. Use this price.")).toBeInTheDocument();
    expect(row("Ask ₹1,223.30, 1 share, 66 total. Use this price.")).toBeInTheDocument();
    expect(row("Ask ₹1,223.35, 601 shares, 667 total. Use this price.")).toBeInTheDocument();
    expect(row("Bid ₹1,223.05, 12 shares, 52 total. Use this price.")).toBeInTheDocument();
  });

  it("is one tab stop, starting on the best ask", async () => {
    const { user } = setup();
    row("Before").focus();
    await user.tab();
    expect(row(/^Ask ₹1,223\.25/)).toHaveFocus();
    await user.tab();
    expect(row("After")).toHaveFocus();
    await user.tab({ shift: true });
    expect(row(/^Ask ₹1,223\.25/)).toHaveFocus();
    const stops = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(stops.map((b) => b.textContent)).toEqual(["Before", expect.any(String), "After"]);
  });

  it("moves with the arrow keys across the spread, and jumps with Home and End", async () => {
    const { user } = setup();
    row(/^Ask ₹1,223\.25/).focus();
    await user.keyboard("{ArrowUp}");
    expect(row(/^Ask ₹1,223\.30/)).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}"); // stops at the top
    expect(row(/^Ask ₹1,223\.35/)).toHaveFocus();
    await user.keyboard("{End}");
    expect(row(/^Bid ₹1,223\.10/)).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}"); // stops at the bottom
    expect(row(/^Bid ₹1,223\.05/)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(row(/^Ask ₹1,223\.25/)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(row(/^Bid ₹1,223\.10/)).toHaveFocus();

    // The tab stop stays where the visitor left it.
    await user.tab();
    await user.tab({ shift: true });
    expect(row(/^Bid ₹1,223\.10/)).toHaveFocus();
  });

  it("uses the focused price with Enter: an ask sets a buy, a bid a sell", async () => {
    const { user, onPick } = setup();
    row(/^Ask ₹1,223\.25/).focus();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("1223.25", "buy");
    await user.keyboard("{End}{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("1223.10", "sell");
  });

  it("marks the visitor's own resting orders, in words as well as a dot", () => {
    setup({ buy: new Set(["1223.05"]), sell: new Set() });
    expect(
      row("Bid ₹1,223.05, 12 shares, 52 total, including your order. Use this price."),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("[data-own-order]")).toHaveLength(1);
  });

  it("is plain text, with no tab stops, where prices can't be picked", () => {
    render(<OrderBookLadder book={book} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
