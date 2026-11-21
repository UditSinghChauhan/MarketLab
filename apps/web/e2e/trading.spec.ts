import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

test.describe("landing page", () => {
  test("shows the live book and traces a real order from the hero", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "A stock exchange you can watch work.",
    );
    await expect(page.getByText("Live order book", { exact: true })).toBeVisible();
    await expect(page.getByText("Invariant violations")).toBeVisible();

    await page.getByRole("button", { name: "Buy 5 shares at market" }).click();
    await expect(page.getByText(/What the exchange did with ord_\d+/)).toBeVisible();
    await expect(page.getByText("Logged to Postgres")).toBeVisible();
    await expect(page.getByText("Filled", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Continue in the terminal" }).click();
    await expect(page).toHaveURL(/\/terminal\/ORBT$/);
    await expect(page.getByRole("cell", { name: "ORBT" })).toBeVisible();
  });
});

test.describe("terminal", () => {
  test("places a limit order, traces it in the inspector, then cancels it", async ({ page }) => {
    await page.goto("/terminal/SOLR");
    await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Buy 10 SOLR/ })).toBeEnabled();

    await page.keyboard.press("l");
    await page.getByRole("textbox", { name: "Shares" }).fill("40");
    await page.getByRole("textbox", { name: /Limit price/ }).fill("250.00");
    await page.getByRole("button", { name: /Buy 40 SOLR/ }).click();
    await expect(page.getByText("Limit order placed for SOLR")).toBeVisible();

    await page.getByRole("tab", { name: /Orders/ }).click();
    const row = page.getByRole("row").filter({ hasText: "40 SOLR" });
    await expect(row.getByText("In the book")).toBeVisible();

    await row.getByRole("button", { name: "Trace" }).click();
    const inspector = page.getByRole("dialog", { name: "Engine inspector" });
    await expect(inspector.getByText("Written to the command log")).toBeVisible();
    await expect(inspector.getByText("Resting in the book")).toBeVisible();
    // This order's numbers, beside the bot median (and the visitor median once
    // there are enough visitor orders), and which step set its latency.
    await expect(
      inspector.getByText(
        /^Matching this order took .+?s\. (Visitors' orders since the server started take a median of .+? \([\d,]+ orders\); the|The) simulated traders' commands, mostly quotes that never trade, take (a median of )?.+?s\. .+ was the slowest step \(.+\), so it set this order's latency\.$/,
      ),
    ).toBeVisible();
    await inspector.getByRole("button", { name: /Close/ }).click();
    await expect(row.getByRole("button", { name: "Trace" })).toBeFocused();

    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(row.getByText("Cancelled")).toBeVisible();
  });

  test("explains a rejected order", async ({ page }) => {
    await page.goto("/terminal/HLXB");
    // Wait for the ticket before typing, as a person would.
    await expect(page.getByRole("button", { name: /Buy 10 HLXB/ })).toBeEnabled();
    await page.keyboard.press("s");
    await page.getByRole("button", { name: /Sell 10 HLXB/ }).click();
    await expect(page.getByText("You don't hold enough shares to sell that many.")).toBeVisible();
  });

  test("switches markets from the top bar", async ({ page }) => {
    await page.goto("/terminal/ORBT");
    await page.getByRole("link", { name: /QNTA/ }).click();
    await expect(page).toHaveURL(/\/terminal\/QNTA$/);
    await expect(page.getByText("Quanta Compute")).toBeVisible();
  });

  test("fits all four market tabs at 1024 px without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/terminal/ORBT");
    const tabs = page.getByRole("navigation", { name: "Markets" }).getByRole("link");
    await expect(tabs).toHaveCount(4);
    for (const tab of await tabs.all()) await expect(tab).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("starts a clean ticket in another market", async ({ page }) => {
    await page.goto("/terminal/ORBT");
    await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
    await page.keyboard.press("s");
    await page.getByRole("textbox", { name: "Shares" }).fill("25");
    await expect(page.getByRole("button", { name: /Sell 25 ORBT/ })).toBeVisible();

    await page.getByRole("link", { name: /QNTA/ }).click();
    await expect(page.getByRole("button", { name: /Buy 10 QNTA/ })).toBeEnabled();
  });

  test("redirects an unknown market and serves a 404 page for unknown routes", async ({ page }) => {
    await page.goto("/terminal/NOPE");
    await expect(page).toHaveURL(/\/terminal\/ORBT$/);
    await page.goto("/no-such-page");
    await expect(page.getByRole("heading", { name: "This page doesn't exist" })).toBeVisible();
  });
});

test.describe("an order whose response is lost", () => {
  // The dropped connection is logged by the browser; each test checks that it
  // is the only problem logged.
  test.use({ allowConsoleErrors: true });

  /**
   * The next order reaches the server and is placed, but its response never
   * reaches the page: the connection drops on the way back. Returns the
   * console errors and uncaught exceptions logged other than that drop.
   */
  async function loseNextOrderResponse(page: Page) {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      if (!message.text().includes("net::ERR_CONNECTION_RESET")) problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
    let lost = false;
    await page.route("**/api/orders", async (route) => {
      if (lost || route.request().method() !== "POST") return route.fallback();
      lost = true;
      await route.fetch(); // the server places the order...
      await route.abort("connectionreset"); // ...and the page never hears back
    });
    return problems;
  }

  test("in the hero: says it may have been placed, and pressing again places it once", async ({
    page,
  }) => {
    await page.goto("/");
    const problems = await loseNextOrderResponse(page);
    const button = page.getByRole("button", { name: "Buy 5 shares at market" });
    await button.click();
    await expect(
      page.getByText(/Couldn't confirm that order; it may have been placed/),
    ).toBeVisible();

    await button.click();
    await expect(
      page.getByText(
        "Your earlier attempt already placed this order (filled). It wasn't placed twice.",
      ),
    ).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("in the terminal: no 'try again', and resending the same order places it once", async ({
    page,
  }) => {
    await page.goto("/terminal/QNTA");
    await expect(page.getByRole("button", { name: /Buy 10 QNTA/ })).toBeEnabled();
    await page.keyboard.press("l");
    await page.getByRole("textbox", { name: "Shares" }).fill("7");
    await page.getByRole("textbox", { name: /Limit price/ }).fill("100.00");

    const problems = await loseNextOrderResponse(page);
    const buy = page.getByRole("button", { name: /Buy 7 QNTA/ });
    await buy.click();
    await expect(
      page.getByText(/Couldn't confirm this order\. It may have been placed/),
    ).toBeVisible();
    await expect(page.getByText(/Try again/)).toHaveCount(0);

    await buy.click();
    await expect(
      page.getByText(
        "Your earlier attempt already placed this order (in the book). It wasn't placed twice.",
      ),
    ).toBeVisible();
    await page.getByRole("tab", { name: /Orders/ }).click();
    await expect(page.getByRole("row").filter({ hasText: "7 QNTA" })).toHaveCount(1);
    expect(problems).toEqual([]);
  });
});
