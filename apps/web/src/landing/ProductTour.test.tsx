// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductTour } from "./ProductTour";

afterEach(cleanup);

const renderTour = () =>
  render(
    <MemoryRouter>
      <ProductTour />
    </MemoryRouter>,
  );

const selected = () => screen.getByRole("tab", { selected: true });

describe("ProductTour", () => {
  it("opens on the terminal, with its screenshot and a link to it", () => {
    renderTour();
    expect(selected()).toHaveTextContent("Trading terminal");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAccessibleName(/Trading terminal/);
    expect(screen.getByRole("img")).toHaveAttribute("src", "/tour/terminal-1120.webp");
    expect(screen.getByRole("link", { name: "Open the terminal" })).toHaveAttribute(
      "href",
      "/terminal",
    );
  });

  it("only the selected tab is in the Tab order", () => {
    renderTour();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves with the arrow keys, Home and End, wrapping at the ends", async () => {
    const user = userEvent.setup();
    renderTour();
    await user.tab();
    expect(selected()).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(selected()).toHaveTextContent("Engine inspector");
    expect(selected()).toHaveFocus();
    expect(screen.getByRole("img")).toHaveAttribute("src", "/tour/inspector-1120.webp");

    await user.keyboard("{End}");
    expect(selected()).toHaveTextContent("Verified replay");
    await user.keyboard("{ArrowRight}");
    expect(selected()).toHaveTextContent("Trading terminal");
    await user.keyboard("{ArrowLeft}");
    expect(selected()).toHaveTextContent("Verified replay");
    await user.keyboard("{Home}");
    expect(selected()).toHaveTextContent("Trading terminal");
  });

  it("switches screen and action on click", async () => {
    const user = userEvent.setup();
    renderTour();
    await user.click(screen.getByRole("tab", { name: /Verified replay/ }));
    expect(screen.getByRole("img")).toHaveAccessibleName(/verdict/);
    expect(screen.getByRole("link", { name: "Run the replay" })).toHaveAttribute("href", "/replay");
  });

  it("offers two widths of each screenshot", () => {
    renderTour();
    expect(screen.getByRole("img").getAttribute("srcset")).toBe(
      "/tour/terminal-1120.webp 1120w, /tour/terminal-2240.webp 2240w",
    );
  });

  it("serves phones a crop of each screen, sized so nothing moves while it loads", async () => {
    const user = userEvent.setup();
    renderTour();
    await user.click(screen.getByRole("tab", { name: /Engine inspector/ }));
    const source = screen.getByRole("img").parentElement?.querySelector("source");
    expect(source).toHaveAttribute("media", "(max-width: 639px)");
    expect(source).toHaveAttribute(
      "srcset",
      "/tour/inspector-phone-800.webp 800w, /tour/inspector-phone-1200.webp 1200w",
    );
    expect(source).toHaveAttribute("width", "400");
    expect(source).toHaveAttribute("height", "600");
  });

  it("describes the phone crop, not the full screenshot, on a phone", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 639px)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    try {
      renderTour();
      expect(screen.getByRole("img")).toHaveAccessibleName(/^The trading terminal on a phone/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
