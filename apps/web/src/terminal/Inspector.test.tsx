// @vitest-environment jsdom
import type { CommandTiming } from "@marketlab/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LatencySummary, slowestStep } from "./Inspector";

const timing = (queueMs: number, persistMs: number, engineUs: number): CommandTiming => ({
  receivedAt: 0,
  queueMs,
  persistMs,
  engineUs,
});

describe("latency summary", () => {
  afterEach(cleanup);

  it("names whichever step took longest", () => {
    expect(slowestStep(timing(0.01, 1.2, 3))).toEqual({
      step: "The write to the command log",
      us: 1200,
    });
    expect(slowestStep(timing(4, 1.2, 3)).step).toBe("Waiting for its turn");
    // An outlier: matching took longer than a fast write.
    expect(slowestStep(timing(0, 0.05, 80)).step).toBe("Matching");
  });

  it("puts this order's engine time beside the engine's median", () => {
    const { container } = render(<LatencySummary timing={timing(0.01, 1.2, 3)} medianUs={0.6} />);
    expect(container.textContent).toBe(
      "Matching this order took 3.0 µs; the engine's median over recent commands is 0.6 µs. " +
        "The write to the command log was the slowest step (1.20 ms), so it set this order's latency.",
    );
  });

  it("stays true for an outlier, and leaves out the median until it has loaded", () => {
    const { container } = render(
      <LatencySummary timing={timing(0, 0.05, 80)} medianUs={undefined} />,
    );
    expect(container.textContent).toBe(
      "Matching this order took 80 µs. Matching was the slowest step (80 µs), so it set this order's latency.",
    );
  });
});
