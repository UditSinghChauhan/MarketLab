/**
 * The replay runs here, off the main thread: this worker owns a `Replayer`
 * (the same engine code the server runs), replays the downloaded log in short
 * bursts so it can report progress, and afterwards answers seeks.
 */

import { Replayer } from "@marketlab/engine";

import type { FromWorker, ReplaySnapshot, ToWorker } from "./protocol";

/** Steps per burst: about 50 ms of work, so progress and seeks stay responsive. */
const BURST = 250;
const REPORT_EVERY_MS = 80;

interface Scope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
}
const scope = self as unknown as Scope;

let replayer: Replayer | undefined;
let symbol = "";
let done = false;
let startedAt = 0;
let elapsedMs = 0;
let totalCommands = 0;
let wanted: number | undefined; // the latest seek, applied once per turn of the event loop
let scheduled = false;

function snapshot(current: Replayer): ReplaySnapshot {
  return {
    done,
    totalSteps: current.totalSteps,
    seq: current.seq,
    verdict: current.verdict,
    elapsedMs: done ? elapsedMs : performance.now() - startedAt,
    totalCommands,
    startTime: current.timeAt(0),
    endTime: current.timeAt(current.totalSteps),
    frame: current.frame(symbol),
  };
}

const report = (current: Replayer) => {
  scope.postMessage({ type: "snapshot", snapshot: snapshot(current) });
};

/** The first pass: replay everything, in bursts, yielding between them. */
function firstPass(current: Replayer, lastReport = 0): void {
  if (current !== replayer) return; // a newer log replaced this one
  current.seek(current.position + BURST);
  if (current.position < current.totalSteps) {
    const now = performance.now();
    const due = now - lastReport >= REPORT_EVERY_MS;
    if (due) report(current);
    setTimeout(() => {
      firstPass(current, due ? now : lastReport);
    }, 0);
    return;
  }
  done = true;
  elapsedMs = performance.now() - startedAt;
  totalCommands = current.commands;
  report(current);
}

function applySeek(): void {
  scheduled = false;
  if (!replayer || !done || wanted === undefined) return;
  replayer.seek(wanted);
  wanted = undefined;
  report(replayer);
}

scope.onmessage = ({ data }) => {
  try {
    switch (data.type) {
      case "load":
        symbol = data.symbol;
        done = false;
        wanted = undefined;
        startedAt = performance.now();
        replayer = new Replayer(data.log, { checkpointEvery: BURST });
        firstPass(replayer);
        return;
      case "symbol":
        symbol = data.symbol;
        if (replayer) report(replayer);
        return;
      case "seek":
        wanted = data.position;
        if (!scheduled) {
          scheduled = true;
          setTimeout(applySeek, 0);
        }
        return;
    }
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "The replay stopped unexpectedly",
    });
  }
};
