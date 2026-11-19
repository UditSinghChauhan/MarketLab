import { expect, test } from "./fixtures";

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
  await expect(guide).toContainText("Tap a price in the order book");
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
