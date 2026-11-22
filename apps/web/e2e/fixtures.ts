import { test as base, expect, type Page } from "@playwright/test";

/**
 * Every test fails if the page logs a console error or warning, or throws.
 * A test that breaks the network on purpose opts out with
 * `test.use({ allowConsoleErrors: true })`.
 */
export const test = base.extend<{ allowConsoleErrors: boolean; consoleGuard: undefined }>({
  allowConsoleErrors: [false, { option: true }],
  consoleGuard: [
    async ({ page, allowConsoleErrors }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        // The browser itself logs any 4xx response. A rejected order answers 422 by
        // design (the ticket explains it), so that one line is expected.
        if (/status of 422/.test(message.text())) return;
        // An unknown page is served with 404 on purpose; only the page's own
        // document may answer 404, never an API call or an asset.
        if (/status of 404/.test(message.text()) && message.location().url === page.url()) return;
        if (message.type() === "error" || message.type() === "warning") {
          problems.push(`${message.type()}: ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
      await use(undefined);
      if (!allowConsoleErrors) expect(problems, "console errors and warnings").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Holds every API request, like a sleeping server, until `wake()` is called. */
export async function sleepingServer(page: Page): Promise<{ wake: () => void }> {
  const gate = { open: (): void => undefined };
  const awake = new Promise<undefined>((resolve) => {
    gate.open = () => {
      resolve(undefined);
    };
  });
  await page.route("**/api/**", async (route) => {
    await awake;
    await route.continue();
  });
  return {
    wake: () => {
      gate.open();
    },
  };
}

/**
 * Records layout shifts from the first paint on and returns the cumulative
 * score so far. Rows moving down the trade tape as new trades print are the
 * live feed doing its job, so shifts made only of those rows are not counted.
 */
export async function trackLayoutShift(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    interface Shift {
      value: number;
      hadRecentInput: boolean;
      sources: { node: Node | null }[];
    }
    const state = window as unknown as { __cls: number };
    state.__cls = 0;
    const inFeed = (node: Node | null) =>
      node instanceof Element && node.closest("[data-live-feed]") !== null;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Shift[]) {
        if (entry.hadRecentInput) continue;
        if (entry.sources.length > 0 && entry.sources.every((s) => inFeed(s.node))) continue;
        state.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  return () => page.evaluate(() => (window as unknown as { __cls: number }).__cls);
}
