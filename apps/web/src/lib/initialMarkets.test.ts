// @vitest-environment jsdom
import type { MarketSummary } from "@marketlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const market = { symbol: "ORBT", last: "1250.00" } as MarketSummary;

/** A fresh copy of the module, which reads the page once and keeps what it found. */
async function load(block: string | null) {
  document.head.innerHTML =
    block === null ? "" : `<script type="application/json" id="initial-markets">${block}</script>`;
  vi.resetModules();
  return (await import("./initialMarkets")).initialMarkets;
}

describe("initialMarkets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = "";
  });

  it("reads the summaries the server put in the page", async () => {
    const initialMarkets = await load(JSON.stringify([market]));
    expect(initialMarkets()).toEqual([market]);
  });

  it("is empty without a block, or with one it cannot parse", async () => {
    expect((await load(null))()).toEqual([]);
    expect((await load("{not json"))()).toEqual([]);
  });

  it("stops using them once they are no longer fresh", async () => {
    const initialMarkets = await load(JSON.stringify([market]));
    vi.spyOn(performance, "now").mockReturnValue(15_000);
    expect(initialMarkets()).toEqual([]);
  });
});
