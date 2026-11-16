// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

function Page({ broken }: { broken: boolean }) {
  if (broken) throw new Error("render failed");
  return <p>All good</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("shows a recovery screen and logs the error when a page crashes", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary resetKey="/terminal/ORBT">
        <Page broken />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "Something broke on this page" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to the market" })).toHaveAttribute(
      "href",
      "/terminal",
    );
    expect(log).toHaveBeenCalledWith(
      "MarketLab page crashed:",
      expect.objectContaining({ message: "render failed" }),
      expect.any(String),
    );
  });

  it("recovers when the visitor moves to another route", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <ErrorBoundary resetKey="/terminal/ORBT">
        <Page broken />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary resetKey="/">
        <Page broken={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeVisible();
  });
});
