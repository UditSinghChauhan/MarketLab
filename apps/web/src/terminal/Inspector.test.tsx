// @vitest-environment jsdom
import type { CommandTiming } from "@marketlab/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LatencySummary, MIN_VISITOR_SAMPLES, slowestStep } from "./Inspector";

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

  const engine = (visitorSamples: number) => ({
    bots: { p50Us: 0.6, p99Us: 3, samples: 4096 },
    visitors: { p50Us: 24, p99Us: 90, samples: visitorSamples },
  });

  it("compares this order with visitors' orders, and bot commands apart", () => {
    const { container } = render(
      <LatencySummary timing={timing(0.01, 1.2, 30)} engine={engine(1234)} />,
    );
    expect(container.textContent).toBe(
      "Matching this order took 30 µs. " +
        "Visitors' orders since the server started take a median of 24 µs (1,234 orders); " +
        "the simulated traders' commands, mostly quotes that never trade, take 0.6 µs. " +
        "The write to the command log was the slowest step (1.20 ms), so it set this order's latency.",
    );
  });

  it(`shows only the bot median until there are ${String(MIN_VISITOR_SAMPLES)} visitor orders`, () => {
    const { container } = render(
      <LatencySummary timing={timing(0.01, 1.2, 3)} engine={engine(MIN_VISITOR_SAMPLES - 1)} />,
    );
    expect(container.textContent).toBe(
      "Matching this order took 3.0 µs. " +
        "The simulated traders' commands, mostly quotes that never trade, take a median of 0.6 µs. " +
        "The write to the command log was the slowest step (1.20 ms), so it set this order's latency.",
    );
  });

  it("stays true for an outlier, and leaves out the medians until they have loaded", () => {
    const { container } = render(
      <LatencySummary timing={timing(0, 0.05, 80)} engine={undefined} />,
    );
    expect(container.textContent).toBe(
      "Matching this order took 80 µs. Matching was the slowest step (80 µs), so it set this order's latency.",
    );
  });
});
