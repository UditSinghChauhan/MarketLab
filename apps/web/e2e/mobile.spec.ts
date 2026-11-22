import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const CHART = 'svg[aria-label^="Price chart"]';

/** The chart's labels and markers that reach outside the chart's own box, if any. */
async function clippedChartParts(page: Page): Promise<string[]> {
  await expect(page.locator(`${CHART} text`).first()).toBeVisible();
  return page.locator(CHART).evaluate((svg) => {
    const box = svg.getBoundingClientRect();
    const clipped: string[] = [];
    for (const part of svg.querySelectorAll("text, rect")) {
      const b = part.getBoundingClientRect();
      if (b.height === 0) continue; // an empty volume bar
      if (b.top < box.top - 0.5 || b.bottom > box.bottom + 0.5) {
        clipped.push(
          `${part.textContent || part.tagName} at ${b.top.toFixed(1)}–${b.bottom.toFixed(1)}`,
        );
      }
    }
    return clipped;
  });
}

// Whether the top grid line lands near the edge depends on the price range, so
// the checks look at many ranges: every market, and many moments of the replay.
test.describe("at 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the terminal chart keeps every price label inside its box", async ({ page }) => {
    for (const symbol of ["ORBT", "QNTA", "SOLR", "HLXB"]) {
      await page.goto(`/terminal/${symbol}`);
      expect(await clippedChartParts(page), symbol).toEqual([]);
    }
  });

  test("the replay chart keeps every price label inside its box", async ({ page }) => {
    await page.goto("/replay");
    const slider = page.getByRole("slider", { name: "Position in the session" });
    await expect(slider).toBeEnabled({ timeout: 20_000 });
    const max = Number(await slider.getAttribute("max"));
    const markets = page.getByRole("navigation", { name: "Markets" });
    for (const symbol of ["ORBT", "QNTA", "SOLR", "HLXB"]) {
      await markets.getByRole("button", { name: symbol }).click();
      for (let i = 1; i <= 15; i++) {
        const at = String(Math.round((max * i) / 15));
        await slider.fill(at);
        await expect(slider).toHaveValue(at);
        expect(await clippedChartParts(page), `${symbol} at ${at}`).toEqual([]);
      }
    }
  });
});

// The mobile project emulates a Pixel 7: a touch screen, so `(hover: none) and (pointer: coarse)`.

test("the ticket comes before the book on a phone", async ({ page }) => {
  await page.goto("/terminal/ORBT");
  const ticket = await page.getByRole("heading", { name: "Place an order" }).boundingBox();
  const book = await page.getByRole("heading", { name: "Order book" }).boundingBox();
  expect(ticket && book && ticket.y < book.y).toBe(true);
});

test("every market is one tap away, with its price and change", async ({ page }) => {
  await page.goto("/terminal/ORBT");
  const markets = page.getByRole("navigation", { name: "Markets" });
  await expect(markets.getByRole("link")).toHaveCount(4);
  for (const link of await markets.getByRole("link").all()) {
    await expect(link).toBeInViewport({ ratio: 1 });
  }
  const hlxb = markets.getByRole("link", { name: /^HLXB/ });
  await expect(hlxb).toHaveText(/^HLXB[\d,]+\.\d{2}(0\.00|[+−]\d+\.\d{2})%$/);

  await hlxb.tap();
  await expect(page).toHaveURL(/\/terminal\/HLXB$/);
  await expect(hlxb).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: /Buy 10 HLXB/ })).toBeEnabled();
});

test("touch screens get no keyboard hints, and the guide says tap", async ({ page }) => {
  await page.goto("/terminal/ORBT");
  await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
  await expect(page.locator("kbd:visible")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Limit", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toBeHidden();

  const guide = page.getByRole("region", { name: "Getting started" });
  await expect(guide).toContainText("Tap a sell-side price to set a limit buy");
  await expect(guide).toContainText("Open the inspector to trace your order");
});

test("the replay page fits a phone, without keyboard hints", async ({ page }) => {
  await page.goto("/replay");
  const markets = page.getByRole("navigation", { name: "Markets" });
  for (const symbol of ["ORBT", "QNTA", "SOLR", "HLXB"]) {
    await expect(markets.getByRole("button", { name: symbol })).toBeInViewport({ ratio: 1 });
  }
  await expect(page.getByRole("link", { name: "Open the terminal" })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: /^Play/ })).toBeVisible();
  await expect(page.locator("kbd:visible")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
