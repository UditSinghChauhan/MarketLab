import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test, trackLayoutShift } from "./fixtures";

const VERIFIED = /Your browser replayed [\d,]+ engine commands and matched the server exactly/;

/**
 * A side of the book is full: it shows as many levels as fit its half of the
 * column (whole rows of at least 28 px), or nearly, as a deep book does, and
 * never more than fit.
 */
async function expectFullSide(page: Page, side: "Asks" | "Bids") {
  const group = page.getByRole("group", { name: side });
  await expect
    .poll(() =>
      group.evaluate((el) => {
        const fit = Math.min(15, Math.floor(el.clientHeight / 28));
        const rows = el.children.length;
        return rows <= fit && rows >= Math.min(fit, 10)
          ? "full"
          : `${String(rows)} of ${String(fit)}`;
      }),
    )
    .toBe("full");
}

test.describe("verified replay", () => {
  test("replays the session in a worker and matches the server's state hash", async ({ page }) => {
    await page.goto("/replay");
    await expect(page.getByText(VERIFIED)).toBeVisible();
    await expect(page.getByText(/State hash [0-9a-f]{16} after log entry [\d,]+/)).toBeVisible();

    // The market shown was rebuilt here: a two-sided book, a chart and a tape.
    await expectFullSide(page, "Asks");
    await expectFullSide(page, "Bids");
    await expect(page.getByRole("img", { name: /Price chart/ })).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Recent trades" }).getByRole("row"),
    ).not.toHaveCount(1);
  });

  test("includes orders a guest placed, and still matches", async ({ page }) => {
    await page.goto("/terminal/SOLR");
    await expect(page.getByRole("button", { name: /Buy 10 SOLR/ })).toBeEnabled();
    await page.getByRole("button", { name: /Buy 10 SOLR/ }).click();
    await expect(page.getByText("Bought 10 SOLR")).toBeVisible();

    await page.getByRole("link", { name: "Replay", exact: true }).click();
    await expect(page).toHaveURL(/\/replay$/);
    await expect(page.getByText(VERIFIED)).toBeVisible();
  });

  test("scrubs to any moment, plays forward and pauses", async ({ page }) => {
    await page.goto("/replay");
    await expect(page.getByText(VERIFIED)).toBeVisible();
    const slider = page.getByRole("slider", { name: "Position in the session" });
    const max = Number(await slider.getAttribute("max"));
    await expect(slider).toHaveValue(String(max)); // starts at the live end
    const asOf = page.getByText(/^As of \d\d:\d\d:\d\d$/);
    const endTime = await asOf.textContent();

    // Back to the very start: an empty market at the reference price.
    await slider.focus();
    await page.keyboard.press("Home");
    await expect(slider).toHaveValue("0");
    await expect(page.getByText("No trades yet in this session.")).toBeVisible();
    await expect(asOf).not.toHaveText(endTime ?? "");

    // The middle of the session has a full book again.
    await slider.fill(String(Math.floor(max / 2)));
    await expectFullSide(page, "Bids");
    await expect(page.getByText(/^Showing \d\d:\d\d:\d\d$/)).toBeVisible();

    // Play moves the timeline on its own; pause stops it.
    await page.getByRole("button", { name: "60×" }).click();
    await page.getByRole("button", { name: /^Play/ }).click();
    await expect(page.getByRole("button", { name: /^Pause/ })).toBeVisible();
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(max / 2 + 20);
    await page.getByRole("button", { name: /^Pause/ }).click();
    const paused = await slider.inputValue();
    await page.waitForTimeout(400);
    await expect(slider).toHaveValue(paused);

    // Scrubbing never changes the verdict.
    await expect(page.getByText(VERIFIED)).toBeVisible();
  });

  test("reports the exact log entry when the log does not match", async ({ page }) => {
    // Hand the browser a log with one tick removed from the first entry.
    await page.route("**/api/replay/entries?*", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        after: number;
        entries: { kind: string; count?: number }[];
      };
      const first = body.entries[0];
      if (body.after === 0 && first?.kind === "ticks" && first.count) first.count -= 1;
      await route.fulfill({ response, json: body });
    });
    await page.goto("/replay");

    await expect(page.getByText("Diverged at log entry 1", { exact: true })).toBeVisible();
    await expect(page.getByText(/server recorded state hash [0-9a-f]{16}/)).toBeVisible();
    await expect(page.getByText(VERIFIED)).toBeHidden();
  });

  test("is reachable from the landing page and the terminal menu", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Replay this session" }).click();
    await expect(page).toHaveURL(/\/replay$/);

    await page.goto("/terminal/ORBT");
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Replay this session" }).click();
    await expect(page).toHaveURL(/\/replay$/);
    await expect(page.getByText(VERIFIED)).toBeVisible();
  });

  test("has no accessibility violations and does not shift while loading", async ({ page }) => {
    const shift = await trackLayoutShift(page);
    await page.goto("/replay");
    await expect(page.getByText(VERIFIED)).toBeVisible();
    await page.waitForTimeout(500);
    expect(await shift()).toBeLessThan(0.01);

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  });
});
