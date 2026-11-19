import type { MarketSummary } from "@marketlab/contracts";

/**
 * Prices are only this fresh for the first moments after the page loaded; the
 * live stream replaces them straight away, and later renders don't use them.
 */
const FRESH_FOR_MS = 15_000;

let embedded: readonly MarketSummary[] | undefined;

/**
 * The market summaries the server put in a terminal page (see
 * `withInitialMarkets` in the API), so the first render shows real prices
 * rather than placeholders. Empty when there are none or they are stale.
 */
export function initialMarkets(): readonly MarketSummary[] {
  if (typeof document === "undefined") return [];
  if (embedded === undefined) {
    try {
      const text = document.getElementById("initial-markets")?.textContent;
      embedded = text ? (JSON.parse(text) as MarketSummary[]) : [];
    } catch {
      embedded = [];
    }
  }
  return performance.now() < FRESH_FOR_MS ? embedded : [];
}
