// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { CommandResult, EventView } from "@marketlab/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Guide, stepsDoneBy } from "./Guide";

const accepted = (
  over: Partial<Extract<EventView, { type: "order.accepted" }>> = {},
): CommandResult => ({
  ok: true,
  orderId: "ord_1",
  rejectReason: null,
  events: [
    {
      type: "order.accepted",
      seq: 1,
      at: 0,
      orderId: "ord_1",
      symbol: "ORBT",
      side: "buy",
      orderType: "limit",
      qty: 10,
      price: "1250.05",
      stopPrice: null,
      ...over,
    },
  ],
  timing: { receivedAt: 0, queueMs: 0, persistMs: 1, engineUs: 2 },
});

const fromAsk = { price: "1250.05", side: "buy" as const };

describe("stepsDoneBy", () => {
  it("ticks both order steps for an accepted limit buy at the picked ask", () => {
    expect(stepsDoneBy(accepted(), fromAsk)).toEqual(["order", "price"]);
  });

  it("ticks nothing for a rejected order, even one from a picked price", () => {
    const rejected = { ...accepted(), ok: false, rejectReason: "insufficient_funds", events: [] };
    expect(stepsDoneBy(rejected, fromAsk)).toEqual([]);
  });

  it.each([
    ["no price was picked", accepted(), null],
    ["a bid was picked (a limit sell)", accepted({ side: "sell" }), { ...fromAsk, side: "sell" }],
    ["the picked price was edited", accepted({ price: "1250.10" }), fromAsk],
    ["it became a market order", accepted({ orderType: "market", price: null }), fromAsk],
  ] as const)("ticks only step one when %s", (_name, result, picked) => {
    expect(stepsDoneBy(result, picked)).toEqual(["order"]);
  });
});

describe("Guide", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks for a click on a sell-side price", () => {
    render(<Guide done={new Set()} onDismiss={vi.fn()} />);
    expect(screen.getByText("Click a sell-side price to set a limit buy")).toBeInTheDocument();
  });

  it("says tap on a touch screen", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<Guide done={new Set()} onDismiss={vi.fn()} />);
    expect(screen.getByText("Tap a sell-side price to set a limit buy")).toBeInTheDocument();
  });
});
