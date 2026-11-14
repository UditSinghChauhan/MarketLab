import AxeBuilder from "@axe-core/playwright";

import { expect, sleepingServer, test, trackLayoutShift } from "./fixtures";

test.describe("cold start", () => {
  test("the landing page renders without the API, waits calmly, then goes live", async ({
    page,
  }) => {
    const server = await sleepingServer(page);
    await page.goto("/");

    // Static content does not wait for the server.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What is simulated" })).toBeVisible();

    await expect(page.getByText("Starting the exchange")).toBeVisible();
    await expect(page.getByText(/free server sleeps when idle/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Buy 5 shares at market" })).toBeDisabled();

    server.wake();
    await expect(page.getByText("Live order book", { exact: true })).toBeVisible();
    await expect(page.getByText("Starting the exchange")).toBeHidden();
    await expect(page.getByRole("button", { name: "Buy 5 shares at market" })).toBeEnabled();
  });

  test("the terminal shows the same state and connects on its own", async ({ page }) => {
    const server = await sleepingServer(page);
    await page.goto("/terminal/ORBT");

    await expect(page.getByText("Starting the exchange")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Starting$/ })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0); // no error banner while waking

    server.wake();
    await expect(page.getByRole("status").filter({ hasText: /^Live$/ })).toBeVisible();
    await expect(page.getByText("Starting the exchange")).toBeHidden();
    await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
  });
});

test.describe("first run", () => {
  test("the guide ticks off steps and never returns once dismissed", async ({ page }) => {
    await page.goto("/terminal/SOLR");
    const guide = page.getByRole("region", { name: "Getting started" });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("listitem")).toHaveCount(3);

    await page.getByRole("button", { name: /^Ask / }).first().click();
    await expect(guide.getByRole("img", { name: "Done" })).toHaveCount(1);

    await guide.getByRole("button", { name: "Dismiss" }).click();
    await expect(guide).toBeHidden();
    await page.reload();
    await expect(page.getByRole("button", { name: /Buy 10 SOLR/ })).toBeEnabled();
    await expect(guide).toBeHidden();
  });

  test("finishing all three steps closes the guide", async ({ page }) => {
    await page.goto("/terminal/SOLR");
    const guide = page.getByRole("region", { name: "Getting started" });
    await expect(page.getByRole("button", { name: /Buy 10 SOLR/ })).toBeEnabled();

    await page.getByRole("button", { name: /Buy 10 SOLR/ }).click();
    await expect(page.getByText("Bought 10 SOLR")).toBeVisible();
    await page.getByRole("button", { name: /^Bid / }).first().click();
    await page.keyboard.press("i");
    await expect(page.getByRole("dialog", { name: "Engine inspector" })).toBeVisible();
    await expect(guide).toBeHidden();
  });
});

test.describe("terminal header menu", () => {
  test("links to the explanation, the source and the design decisions", async ({ page }) => {
    await page.goto("/terminal/ORBT");
    const more = page.getByRole("button", { name: "More" });
    await more.focus();
    await page.keyboard.press("Enter");

    const menu = page.getByRole("menu", { name: "More" });
    await expect(menu.getByRole("menuitem", { name: "How it works" })).toBeFocused();
    await expect(menu.getByRole("menuitem", { name: /Source on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/UditSinghChauhan/MarketLab",
    );
    await expect(menu.getByRole("menuitem", { name: /Design decisions/ })).toHaveAttribute(
      "href",
      "https://github.com/UditSinghChauhan/MarketLab/tree/main/docs/adr",
    );

    await page.keyboard.press("ArrowUp"); // wraps to the last item
    await expect(menu.getByRole("menuitem", { name: /Start over/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await menu.getByRole("menuitem", { name: "How it works" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("starts over with a new account after confirmation", async ({ page }) => {
    await page.goto("/terminal/SOLR");
    await expect(page.getByRole("button", { name: /Buy 10 SOLR/ })).toBeEnabled();
    await page.getByRole("button", { name: /Buy 10 SOLR/ }).click();
    await expect(page.getByRole("cell", { name: "SOLR", exact: true })).toBeVisible();
    const account = () =>
      page.evaluate(
        () =>
          (JSON.parse(localStorage.getItem("marketlab.session") ?? "{}") as { accountId?: string })
            .accountId,
      );
    const before = await account();

    const more = page.getByRole("button", { name: "More" });
    await more.click();
    await page.getByRole("menuitem", { name: /Start over/ }).click();
    const dialog = page.getByRole("dialog", { name: "Start over with a new account?" });
    await expect(dialog.getByRole("button", { name: "Keep this account" })).toBeFocused();

    // Cancelling keeps the account and returns focus to the menu button.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(more).toBeFocused();
    expect(await account()).toBe(before);

    await more.click();
    await page.getByRole("menuitem", { name: /Start over/ }).click();
    await dialog.getByRole("button", { name: "Start over" }).click();
    await expect(page.getByText("You don't hold anything yet")).toBeVisible();
    await expect.poll(account).not.toBe(before);
    expect(await account()).toMatch(/^g_/);
  });
});

test.describe("keyboard", () => {
  test("the shortcuts dialog traps focus, closes on Escape and returns focus", async ({ page }) => {
    await page.goto("/terminal/ORBT");
    const opener = page.getByRole("button", { name: "Keyboard shortcuts" });
    await opener.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const close = dialog.getByRole("button", { name: /Close/ });
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused(); // the only control: focus stays inside
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();

    // Letters typed in a dialog do not reach the order ticket behind it.
    await page.keyboard.press("s");
    await expect(page.getByRole("radio", { name: /Buy/ })).toHaveAttribute("aria-checked", "true");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("the inspector keeps Tab inside and Escape closes it without clearing the ticket", async ({
    page,
  }) => {
    await page.goto("/terminal/ORBT");
    await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
    await page.getByRole("textbox", { name: "Shares" }).fill("25");
    const opener = page.getByRole("button", { name: /Inspector/ });
    await opener.click();

    const inspector = page.getByRole("dialog", { name: "Engine inspector" });
    await expect(inspector.getByRole("button", { name: /Close/ })).toBeFocused();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      expect(await inspector.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(inspector).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Shares" })).toHaveValue("25");
  });
});

test.describe("accessibility (axe)", () => {
  const audit = async (page: import("@playwright/test").Page) => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    return violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
  };

  test("landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Live order book", { exact: true })).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });

  test("terminal", async ({ page }) => {
    await page.goto("/terminal/ORBT");
    await expect(page.getByRole("status").filter({ hasText: /^Live$/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /Price chart/ })).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });

  test("terminal with the inspector open", async ({ page }) => {
    await page.goto("/terminal/ORBT");
    await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
    await page.getByRole("button", { name: /Buy 10 ORBT/ }).click();
    await expect(page.getByText("Bought 10 ORBT")).toBeVisible();
    await page.keyboard.press("i");
    const inspector = page.getByRole("dialog", { name: "Engine inspector" });
    await expect(inspector.getByText("Matched by the engine")).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });
});

test.describe("layout stability", () => {
  for (const path of ["/", "/terminal/ORBT"]) {
    test(`nothing shifts while ${path} loads`, async ({ page }) => {
      const shift = await trackLayoutShift(page);
      await page.goto(path);
      await expect(
        path === "/"
          ? page.getByText("Live order book", { exact: true })
          : page.getByRole("img", { name: /Price chart/ }),
      ).toBeVisible();
      await page.waitForTimeout(1_500);
      expect(await shift()).toBeLessThan(0.01);
    });
  }
});
