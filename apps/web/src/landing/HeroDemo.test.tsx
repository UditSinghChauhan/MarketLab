// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { CommandResult } from "@marketlab/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureSession } from "../lib/session";
import { HeroDemo } from "./HeroDemo";

vi.mock("../lib/health", () => ({
  useExchange: () => ({ state: "ready", health: null, waitingSince: null }),
}));
vi.mock("../lib/stream", () => ({
  useMarketStream: () => ({ markets: [], status: "live", book: null }),
}));
vi.mock("../lib/session", () => ({ ensureSession: vi.fn() }));

const placed: CommandResult = {
  ok: true,
  orderId: "ord_9",
  rejectReason: null,
  events: [],
  timing: { receivedAt: 0, queueMs: 0, persistMs: 1, engineUs: 2 },
};

const fetchMock = vi.fn<typeof fetch>();
const respond = (status: number, body: string) => {
  fetchMock.mockResolvedValueOnce(new Response(body, { status }));
};
const sent = (call: number) =>
  (JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string) as { clientOrderId: string })
    .clientOrderId;
const UNKNOWN = /Couldn't confirm that order; it may have been placed\. .* on this page/;

function setup() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <HeroDemo />
    </MemoryRouter>,
  );
  const buy = () => user.click(screen.getByRole("button", { name: "Buy 5 shares at market" }));
  return { user, buy };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(ensureSession).mockResolvedValue({ token: "t", accountId: "g_1", expiresAt: 1 });
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("HeroDemo order button", () => {
  it.each([
    [
      "a 201 with an empty body",
      () => {
        respond(201, "");
      },
    ],
    [
      "a 201 with a body that is not a command result",
      () => {
        respond(201, '{"ok":true}');
      },
    ],
    [
      "a 503",
      () => {
        respond(503, '{"error":{"code":"unavailable","message":"Restarting"}}');
      },
    ],
    [
      "no response",
      () => {
        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      },
    ],
  ])("after %s, says it may be placed and resends with the same id", async (_name, fail) => {
    const { buy } = setup();
    fail();
    await buy();
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();

    respond(200, JSON.stringify({ ...placed, replayed: true, order: null }));
    await buy();
    expect(
      await screen.findByText(
        "Your earlier attempt already placed this order. It wasn't placed twice.",
      ),
    ).toBeInTheDocument();
    expect(sent(1)).toBe(sent(0));
  });

  it("treats a placed order and a refusal as settled: the next order gets a new id", async () => {
    const { user, buy } = setup();
    respond(201, JSON.stringify(placed));
    await buy();
    await user.click(await screen.findByRole("button", { name: "Back to the book" }));

    respond(429, '{"error":{"code":"rate_limited","message":"Too many requests"}}');
    await buy();
    expect(await screen.findByText("Too many requests")).toBeInTheDocument();

    respond(201, JSON.stringify(placed));
    await buy();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    expect(new Set([sent(0), sent(1), sent(2)]).size).toBe(3);
  });

  it("does not report an unknown order when no order was sent (the guest session failed)", async () => {
    vi.mocked(ensureSession).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { buy } = setup();
    await buy();
    expect(await screen.findByText("The exchange isn't reachable right now.")).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
