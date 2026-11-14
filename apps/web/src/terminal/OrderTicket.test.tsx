// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { AccountView, CommandResult, MarketSummary } from "@marketlab/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrderTicket, type Prefill } from "./OrderTicket";

const market: MarketSummary = {
  symbol: "ORBT",
  name: "Orbit Aerospace",
  sector: "Aerospace",
  tick: "0.05",
  last: "1250.00",
  open: "1250.00",
  high: "1251.00",
  low: "1249.00",
  change: "0.00",
  changePct: 0,
  bid: "1249.95",
  ask: "1250.05",
  volume: 100,
  trades: 10,
};

const account: AccountView = {
  accountId: "g_test",
  cash: { available: "1000000.00", reserved: "0.00" },
  positions: [],
  equity: "1000000.00",
  startingEquity: "1000000.00",
  pnl: "0.00",
  pnlPct: 0,
};

const accepted: CommandResult = {
  ok: true,
  orderId: "ord_7",
  rejectReason: null,
  events: [
    {
      type: "order.accepted",
      seq: 7,
      at: 0,
      orderId: "ord_7",
      symbol: "ORBT",
      side: "buy",
      orderType: "market",
      qty: 10,
      price: null,
      stopPrice: null,
    },
    {
      type: "trade",
      seq: 8,
      at: 0,
      symbol: "ORBT",
      price: "1250.05",
      qty: 10,
      buyOrderId: "ord_7",
      sellOrderId: "ord_3",
      aggressor: "buy",
    },
  ],
  timing: { receivedAt: 0, queueMs: 0, persistMs: 1, engineUs: 2 },
};

const fetchMock = vi.fn<typeof fetch>();

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

function setup(prefill: Prefill | null = null) {
  const onResult = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <OrderTicket
      market={market}
      account={account}
      token="t"
      prefill={prefill}
      onResult={onResult}
    />,
  );
  return { user, onResult, view };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("OrderTicket", () => {
  it("places a market buy and confirms it in plain words", async () => {
    const { user, onResult } = setup();
    respond(201, accepted);

    await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));

    expect(await screen.findByText("Bought 10 ORBT")).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith(accepted);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/orders");
    expect(JSON.parse(init?.body as string)).toEqual({
      symbol: "ORBT",
      side: "buy",
      type: "market",
      qty: 10,
    });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
  });

  it("switches side and type from the keyboard", async () => {
    const { user } = setup();
    await user.keyboard("s");
    await user.keyboard("l");
    expect(screen.getByRole("radio", { name: /Sell/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Limit/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: /Sell 10 ORBT/ })).toBeInTheDocument();
  });

  it("does not treat letters typed into a field as shortcuts", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("textbox", { name: /Shares/ }));
    await user.keyboard("s");
    expect(screen.getByRole("radio", { name: /Buy/ })).toHaveAttribute("aria-checked", "true");
  });

  it("shows the shared schema's message instead of sending an invalid order", async () => {
    const { user } = setup();
    await user.keyboard("l");
    await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
    expect(await screen.findByText("Enter a rupee amount like 1250.05")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains an engine rejection", async () => {
    const { user } = setup();
    respond(422, {
      ...accepted,
      ok: false,
      orderId: null,
      rejectReason: "insufficient_shares",
      events: [],
    });
    await user.keyboard("s");
    await user.click(screen.getByRole("button", { name: /Sell 10 ORBT/ }));
    expect(
      await screen.findByText("You don't hold enough shares to sell that many."),
    ).toBeInTheDocument();
  });

  it("fills in a limit order from a clicked book price", () => {
    const { view, onResult } = setup();
    view.rerender(
      <OrderTicket
        market={market}
        account={account}
        token="t"
        prefill={{ price: "1249.95", side: "sell", nonce: 1 }}
        onResult={onResult}
      />,
    );
    expect(screen.getByRole("radio", { name: /Limit/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: /Limit price/ })).toHaveValue("1249.95");
    expect(screen.getByRole("button", { name: /Sell 10 ORBT/ })).toBeInTheDocument();
  });

  it("moves a limit price one tick with the arrow keys", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Best ask/ }));
    const input = screen.getByRole("textbox", { name: /Limit price/ });
    await user.click(input);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveValue("1250.15");
  });

  it("does not place an order when Enter activates a focused button", async () => {
    const { user } = setup();
    screen.getByRole("radio", { name: /Sell/ }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
