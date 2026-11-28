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
  test("the guide ticks a step only once its order is accepted, and never returns once dismissed", async ({
    page,
  }) => {
    await page.goto("/terminal/SOLR");
    const guide = page.getByRole("region", { name: "Getting started" });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("listitem")).toHaveCount(3);
    await expect(guide).toContainText("Click a sell-side price to set a limit buy");
    const done = guide.getByRole("img", { name: "Done" });

    // Picking a price sets up the order; nothing is done until it is accepted.
    await page.getByRole("button", { name: /^Ask / }).last().click();
    await expect(page.getByRole("textbox", { name: /Limit price/ })).not.toHaveValue("");
    await expect(done).toHaveCount(0);

    await page.getByRole("button", { name: /Buy 10 SOLR/ }).click();
    await expect(page.getByText(/^(Bought \d+ SOLR|Limit order placed for SOLR)$/)).toBeVisible();
    await expect(done).toHaveCount(2); // placed an order, and a limit buy from the book

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

    // A limit sell from a bid places an order, but isn't step two.
    await page.getByRole("button", { name: /Buy 10 SOLR/ }).click();
    await expect(page.getByText("Bought 10 SOLR")).toBeVisible();
    await page.getByRole("button", { name: /^Bid / }).first().click();
    await page.getByRole("button", { name: /Sell 10 SOLR/ }).click();
    await expect(page.getByText(/^(Sold \d+ SOLR|Limit order placed for SOLR)$/)).toBeVisible();
    await expect(guide.getByRole("img", { name: "Done" })).toHaveCount(1);

    await page.getByRole("button", { name: /^Ask / }).last().click();
    await page.getByRole("button", { name: /Buy 10 SOLR/ }).click();
    await expect(guide.getByRole("img", { name: "Done" })).toHaveCount(2);
    await page.keyboard.press("i");
    await expect(page.getByRole("dialog", { name: "Engine inspector" })).toBeVisible();
    await expect(guide).toBeHidden();
  });
});

test("the landing page tour shows each screen's real screenshot", async ({ page }) => {
  await page.goto("/");
  const tour = page.locator("#tour");
  await tour.scrollIntoViewIfNeeded();
  for (const [tab, file] of [
    ["Trading terminal", "terminal"],
    ["Engine inspector", "inspector"],
    ["Verified replay", "replay"],
  ] as const) {
    await tour.getByRole("tab", { name: new RegExp(tab) }).click();
    const image = tour.getByRole("tabpanel").getByRole("img");
    await expect(image).toHaveAttribute("src", `/tour/${file}-1120.webp`);
    // Decoded, so the file exists in the build and is a real image.
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0);
  }
});

test("the landing page ends with a way into the product", async ({ page }) => {
  await page.goto("/");
  const close = page.getByRole("region", { name: "Place an order and watch where it goes." });
  await expect(close.getByRole("link", { name: "Open the terminal" })).toHaveAttribute(
    "href",
    "/terminal",
  );
  await expect(close.getByRole("link", { name: "Run the replay" })).toHaveAttribute(
    "href",
    "/replay",
  );
});

test("the landing page footer links to the author and the source", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  const author = footer.getByRole("list", { name: "Contact the author" });
  await expect(author.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/UditSinghChauhan",
  );
  await expect(author.getByRole("link", { name: "LinkedIn" })).toHaveAttribute(
    "href",
    "https://www.linkedin.com/in/udit-singh-31382137a/",
  );
  await expect(author.getByRole("link", { name: "uditsinghchauhan720@gmail.com" })).toHaveAttribute(
    "href",
    "mailto:uditsinghchauhan720@gmail.com",
  );
  await expect(footer.getByRole("link", { name: "Source code" })).toHaveAttribute(
    "href",
    "https://github.com/UditSinghChauhan/MarketLab",
  );
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

test.describe("keyboard: the order book", () => {
  test("is one tab stop on the way to the ticket; arrows move, Enter uses the price", async ({
    page,
  }) => {
    await page.goto("/terminal/ORBT");
    await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
    const ticket = page.getByRole("region", { name: "Place an order" });
    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        const section = el?.closest("section");
        return {
          name: el?.getAttribute("aria-label") ?? el?.textContent.trim() ?? "",
          inTicket: section?.querySelector("h2")?.textContent === "Place an order",
        };
      });

    // From the top of the page, every tab stop up to the ticket: the book is one of them.
    const stops: string[] = [];
    for (let presses = 0; presses < 20; presses++) {
      await page.keyboard.press("Tab");
      const now = await focused();
      if (now.inTicket) break;
      stops.push(now.name);
    }
    await expect(ticket.getByRole("radio", { name: /Buy/ })).toBeFocused();
    expect(stops.filter((s) => /^(Ask|Bid) ₹/.test(s))).toHaveLength(1);
    expect(stops.length).toBeLessThanOrEqual(13);

    // Back into the book: it starts on the best ask.
    await page.keyboard.press("Shift+Tab");
    expect((await focused()).name).toMatch(
      /^Ask ₹[\d,]+\.\d\d, [\d,]+ shares?, [\d,]+ total(, including your order)?\. Use this price\.$/,
    );
    await page.keyboard.press("ArrowUp");
    expect((await focused()).name).toMatch(/^Ask ₹/);
    await page.keyboard.press("End");
    expect((await focused()).name).toMatch(/^Bid ₹/);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    expect((await focused()).name).toMatch(/^Bid ₹/);

    // Enter uses the bid's price: a limit sell, and the ticket is one Tab away.
    await page.keyboard.press("Enter");
    await expect(ticket.getByRole("radio", { name: /Sell/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(ticket.getByRole("textbox", { name: /Limit price/ })).toHaveValue(/^\d+\.\d{2}$/);
    await page.keyboard.press("Tab");
    await expect(ticket.getByRole("radio", { name: /Buy/ })).toBeFocused();
  });
});

test.describe("accessibility (axe)", () => {
  // Every rule, whatever its impact.
  const audit = async (page: import("@playwright/test").Page) => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    return violations.map(
      (v) =>
        `${v.id} (${String(v.impact)}): ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
    );
  };

  test("replay page", async ({ page }) => {
    await page.goto("/replay");
    await expect(page.getByText(/Your browser replayed [\d,]+ engine commands/)).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });

  test("404 page", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This page doesn't exist");
    expect(await audit(page)).toEqual([]);
  });

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
