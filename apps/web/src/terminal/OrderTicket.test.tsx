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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const fetchMock = vi.fn<typeof fetch>();

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

const holding: AccountView = {
  ...account,
  positions: [
    {
      symbol: "ORBT",
      qty: 50,
      reserved: 10,
      avgPrice: "1240.50",
      last: "1250.00",
      marketValue: "62500.00",
      unrealizedPnl: "475.00",
      realizedPnl: "0.00",
    },
  ],
};

function setup(prefill: Prefill | null = null, withAccount: AccountView = account) {
  const onResult = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <OrderTicket
      market={market}
      account={withAccount}
      token="t"
      prefill={prefill}
      onResult={onResult}
    />,
  );
  return { user, onResult, view };
}

const shares = () => screen.getByRole("textbox", { name: /Shares/ });
const placeButton = () => screen.getByRole("button", { name: /^(Buy|Sell)\b/ });

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
    const { clientOrderId, ...order } = JSON.parse(init?.body as string) as {
      clientOrderId: string;
    };
    expect(order).toEqual({ symbol: "ORBT", side: "buy", type: "market", qty: 10 });
    expect(clientOrderId).toMatch(UUID);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
  });

  describe("when the outcome is unknown", () => {
    const sent = (call: number) =>
      (JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string) as { clientOrderId: string })
        .clientOrderId;

    it.each([
      ["no response", () => fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))],
      [
        "a 503",
        () => {
          respond(503, { error: { code: "unavailable", message: "The exchange is restarting" } });
        },
      ],
    ])(
      "after %s, says the order may have been placed, and resends it with the same id",
      async (_name, fail) => {
        const { user, onResult } = setup();
        fail();
        await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
        expect(
          await screen.findByText(
            /Couldn't confirm this order\. It may have been placed: check Orders/,
          ),
        ).toBeInTheDocument();
        expect(screen.queryByText(/Try again/)).not.toBeInTheDocument();
        expect(onResult).not.toHaveBeenCalled();

        // The first attempt had been placed: the exchange answers with it.
        respond(200, {
          ...accepted,
          events: [],
          replayed: true,
          order: { status: "filled", filled: 10 },
        });
        await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
        expect(
          await screen.findByText(
            "Your earlier attempt already placed this order (filled). It wasn't placed twice.",
          ),
        ).toBeInTheDocument();
        expect(sent(1)).toBe(sent(0));

        // That order is settled: the next one is a new order with a new id.
        respond(201, accepted);
        await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledTimes(3);
        });
        expect(sent(2)).not.toBe(sent(0));
      },
    );

    it("uses a new id once the order's details change", async () => {
      const { user } = setup();
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      await screen.findByText(/Couldn't confirm this order/);
      const qty = screen.getByRole("textbox", { name: /Shares/ });
      await user.clear(qty);
      await user.type(qty, "11");
      respond(201, accepted);
      await user.click(screen.getByRole("button", { name: /Buy 11 ORBT/ }));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      expect(sent(1)).not.toBe(sent(0));
    });

    it.each([
      ["an empty body", ""],
      ["a body that is not JSON", "{ok: tru"],
      ["JSON that is not a command result", JSON.stringify({ ok: true })],
    ])(
      "after a 201 with %s, keeps the id: the order may exist, so a resend must reuse it",
      async (_name, body) => {
        const { user, onResult } = setup();
        fetchMock.mockResolvedValueOnce(new Response(body, { status: 201 }));
        await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
        expect(
          await screen.findByText(
            /Couldn't confirm this order\. It may have been placed: check Orders/,
          ),
        ).toBeInTheDocument();
        expect(onResult).not.toHaveBeenCalled();

        respond(200, { ...accepted, events: [], replayed: true, order: null });
        await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
        expect(
          await screen.findByText(
            "Your earlier attempt already placed this order. It wasn't placed twice.",
          ),
        ).toBeInTheDocument();
        expect(sent(1)).toBe(sent(0));
      },
    );

    it("forgets the id when the ticket remounts (a reload or a market switch): the resend is a new order", async () => {
      // Documents a known limit (ADR 0004): the id lives only in the mounted
      // form, so the server cannot recognise a resend made after a remount.
      const first = setup();
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await first.user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      await screen.findByText(/Couldn't confirm this order/);
      first.view.unmount();

      const second = setup();
      respond(201, accepted);
      await second.user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      expect(sent(1)).not.toBe(sent(0));
    });

    it("treats a refusal as settled: the message is the server's, the next attempt is new", async () => {
      const { user } = setup();
      respond(429, { error: { code: "rate_limited", message: "Too many orders; slow down" } });
      await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      expect(await screen.findByText("Too many orders; slow down")).toBeInTheDocument();
      respond(201, accepted);
      await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      expect(sent(1)).not.toBe(sent(0));
    });

    it("settles after a placed order and after an engine rejection: each next order is new", async () => {
      const { user } = setup();
      respond(201, accepted);
      await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      await screen.findByText("Bought 10 ORBT");
      respond(422, { ...accepted, ok: false, orderId: null, rejectReason: "off_tick", events: [] });
      await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      await screen.findByText(/Prices move in steps/);
      respond(201, accepted);
      await user.click(screen.getByRole("button", { name: /Buy 10 ORBT/ }));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
      expect(new Set([sent(0), sent(1), sent(2)]).size).toBe(3);
    });
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

  describe("checks each field as it is typed", () => {
    it("asks for a missing limit price, and can't be placed until it has one", async () => {
      const { user } = setup();
      await user.keyboard("l");
      expect(screen.getByText("Enter a limit price.")).toBeInTheDocument();
      // A hint, not an error: nothing has been typed wrong yet.
      expect(screen.getByRole("textbox", { name: /Limit price/ })).not.toHaveAttribute(
        "aria-invalid",
      );
      expect(placeButton()).toBeDisabled();
      await user.keyboard("{Enter}");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("names the two nearest valid prices for an off-tick price", async () => {
      const { user } = setup();
      await user.keyboard("l");
      const input = screen.getByRole("textbox", { name: /Limit price/ });
      await user.type(input, "1250.07");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription(
        "Prices move in steps of ₹0.05. The nearest are ₹1,250.05 and ₹1,250.10.",
      );
      expect(placeButton()).toBeDisabled();
      await user.clear(input);
      await user.type(input, "1250.10");
      expect(input).not.toHaveAttribute("aria-invalid");
      expect(placeButton()).toBeEnabled();
    });

    it.each([
      ["", "Enter a number of shares."],
      ["0", "Enter at least 1 share."],
    ])("never offers to buy zero shares: %j reads “Buy ORBT”", async (typed, message) => {
      const { user } = setup();
      await user.clear(shares());
      if (typed) await user.type(shares(), typed);
      expect(placeButton()).toHaveAccessibleName(/^Buy ORBT\s*Enter$/);
      expect(placeButton()).toBeDisabled();
      expect(shares()).toHaveAccessibleDescription(message);
    });

    it("caps one order at 1,00,000 shares, in the app's number format", async () => {
      const { user } = setup();
      await user.clear(shares());
      await user.type(shares(), "100001");
      expect(shares()).toHaveAccessibleDescription("One order can be at most 1,00,000 shares.");
      expect(placeButton()).toBeDisabled();
    });

    it("blocks a buy the available cash can't cover, and says how many shares fit", async () => {
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: /Best ask/ }));
      await user.clear(shares());
      await user.type(shares(), "1000");
      expect(shares()).toHaveAccessibleDescription(
        "That costs ₹12,50,050.00, more than your ₹10,00,000.00 cash. Up to 799 shares fit.",
      );
      expect(placeButton()).toBeDisabled();
    });

    it("blocks selling shares the account doesn't hold, before anything is sent", async () => {
      const { user } = setup();
      await user.keyboard("s");
      expect(shares()).toHaveAccessibleDescription("You have no ORBT to sell.");
      expect(placeButton()).toBeDisabled();
      await user.keyboard("{Enter}");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts only shares not already promised to open sell orders", async () => {
      const { user } = setup(null, holding);
      await user.keyboard("s");
      expect(placeButton()).toBeEnabled(); // 10 of the 40 sellable
      await user.clear(shares());
      await user.type(shares(), "41");
      expect(shares()).toHaveAccessibleDescription("You can sell up to 40 ORBT.");
      expect(placeButton()).toBeDisabled();
    });
  });

  it("shows the holding in this market, with its average price", () => {
    setup(null, holding);
    expect(screen.getByText(/You hold/)).toHaveTextContent("You hold 50 ORBT at avg ₹1,240.50");
  });

  it("shows no holding line without a position", () => {
    setup();
    expect(screen.queryByText(/You hold/)).not.toBeInTheDocument();
  });

  it.each([
    ["the side", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("s")],
    ["the type", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("l")],
    [
      "the quantity",
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(shares(), "0");
      },
    ],
    [
      "the price",
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole("button", { name: /Best bid/ }));
      },
    ],
  ])("clears the last order's outcome when %s changes", async (_name, change) => {
    const { user } = setup(null, holding);
    respond(201, accepted);
    await user.click(placeButton());
    expect(await screen.findByText("Bought 10 ORBT")).toBeInTheDocument();
    await change(user);
    expect(screen.queryByText("Bought 10 ORBT")).not.toBeInTheDocument();
  });

  it("still explains a rejection the exchange makes after the checks passed (a race)", async () => {
    // The ticket saw 40 sellable shares; by the time the order arrived, they were gone.
    const { user } = setup(null, holding);
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
