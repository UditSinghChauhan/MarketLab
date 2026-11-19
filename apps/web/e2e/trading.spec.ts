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
