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
    // The account value and P&L stay in view above the panel while tracing.
    const header = await page.getByRole("banner").boundingBox();
    const panel = await inspector.boundingBox();
    expect(panel?.y).toBe((header?.y ?? 0) + (header?.height ?? 0));
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

  test("the tape shows each trade once, newest first, after the guest session connects", async ({
    page,
  }) => {
    // A fresh visitor's stream opens before their guest session exists, and the
    // session's stream then resends the tape. Holding the session until the first
    // tape has arrived makes that overlap happen every time, not on a race.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/session", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/terminal/ORBT");
    const rows = page.locator("[data-live-feed] tr[data-seq]");
    await expect(rows.first()).toBeVisible();
    release();
    // The session's stream is open once the account has loaded; let a few ticks print.
    await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
    await page.waitForTimeout(2_000);

    const tape = await rows.evaluateAll((trs) =>
      trs.map((tr) => ({
        seq: Number(tr.getAttribute("data-seq")),
        time: tr.lastElementChild?.textContent ?? "",
      })),
    );
    expect(tape.length).toBeGreaterThan(0);
    expect(tape.length).toBeLessThanOrEqual(60);
    expect(new Set(tape.map((t) => t.seq)).size).toBe(tape.length);
    for (let i = 1; i < tape.length; i++) {
      const [newer, older] = [tape[i - 1], tape[i]];
      expect(older?.seq).toBeLessThan(newer?.seq ?? 0);
      // Clock times (HH:MM:SS): trades from one engine tick share a time.
      expect((older?.time ?? "") <= (newer?.time ?? "")).toBe(true);
    }
  });

  test("checks the ticket as it is typed, and won't send an order the exchange would refuse", async ({
    page,
  }) => {
    await page.goto("/terminal/HLXB");
    // Wait for the ticket before typing, as a person would.
    await expect(page.getByRole("button", { name: /Buy 10 HLXB/ })).toBeEnabled();
    let sent = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/orders")) sent += 1;
    });

    // Selling shares not held.
    await page.keyboard.press("s");
    const shares = page.getByRole("textbox", { name: "Shares" });
    await expect(shares).toHaveAccessibleDescription("You have no HLXB to sell.");
    await expect(page.getByRole("button", { name: /Sell 10 HLXB/ })).toBeDisabled();
    await page.keyboard.press("Enter");

    // An off-tick price, then a quantity over the limit.
    await page.keyboard.press("b");
    await page.keyboard.press("l");
    const limit = page.getByRole("textbox", { name: /Limit price/ });
    await limit.fill("2000.03");
    await expect(limit).toHaveAccessibleDescription(
      "Prices move in steps of ₹0.05. The nearest are ₹2,000.00 and ₹2,000.05.",
    );
    await limit.fill("2000.05");
    await shares.fill("100001");
    await expect(shares).toHaveAccessibleDescription("One order can be at most 1,00,000 shares.");
    await shares.fill("");
    await expect(page.getByRole("button", { name: /^Buy HLXB/ })).toBeDisabled();
    expect(sent).toBe(0);

    await shares.fill("1");
    await page.getByRole("button", { name: /Buy 1 HLXB/ }).click();
    await expect(page.getByText(/^(Bought 1 HLXB|Limit order placed for HLXB)$/)).toBeVisible();
    expect(sent).toBe(1);
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
    const response = await page.goto("/no-such-page");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "This page doesn't exist" })).toBeVisible();
    await expect(page).toHaveTitle("Page not found · MarketLab");
    await page.getByRole("link", { name: "Back to the home page" }).click();
    await expect(page).toHaveURL(/\/$/);
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
