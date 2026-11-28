// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import type { ConnectionStatus } from "../lib/stream";
import { TerminalHeader } from "./TerminalHeader";

afterEach(cleanup);

const header = (status: ConnectionStatus) => (
  <MemoryRouter>
    <TerminalHeader
      symbol="ORBT"
      markets={[]}
      status={status}
      exchange="ready"
      account={null}
      inspectorOpen={false}
      onToggleInspector={() => undefined}
      onShowShortcuts={() => undefined}
      onStartOver={() => undefined}
    />
  </MemoryRouter>
);

describe("TerminalHeader connection status", () => {
  it("announces each change of connection in one polite live region", () => {
    const { rerender } = render(header("connecting"));
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveTextContent(/^Connecting$/);

    rerender(header("live"));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent(/^Live$/);

    rerender(header("reconnecting"));
    expect(region).toHaveTextContent(/^Reconnecting$/);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
