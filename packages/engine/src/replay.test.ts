import { describe, expect, it } from "vitest";

import type { Command } from "./events.js";
import { parseRupees } from "./money.js";
import { quantity } from "./price.js";
import { Replayer, type ReplayLog } from "./replay.js";
import { SessionEngine, stepTime, stepsIn, type LogEntry, type SessionConfig } from "./session.js";

const TICK = parseRupees("0.05");
const config: SessionConfig = {
  seed: 20_261_115,
  guestCash: parseRupees("1000000"),
  instruments: [
    {
      symbol: "ORBT",
      tickSize: TICK,
      referencePrice: parseRupees("1250.00"),
      volatilityTicks: 10,
      levelGapTicks: 2,
      levelSize: 40,
    },
    {
      symbol: "SOLR",
      tickSize: TICK,
      referencePrice: parseRupees("318.20"),
      volatilityTicks: 4,
      levelGapTicks: 1,
      levelSize: 150,
    },
  ],
};

const T0 = Date.UTC(2026, 10, 15, 9, 15);
const buy = (accountId: string, symbol: string, qty: number, price?: string): Command =>
  price === undefined
    ? { kind: "place", accountId, symbol, side: "buy", type: "market", qty: quantity(qty) }
    : {
        kind: "place",
        accountId,
        symbol,
        side: "buy",
        type: "limit",
        qty: quantity(qty),
        limitPrice: parseRupees(price),
      };

/**
 * Plays a session the way the server does (whole entries through
 * `SessionEngine.apply`), recording before each entry the hash of the state it
 * is applied to, and returns the log a client would download.
 */
function recordSession(): ReplayLog {
  const engine = new SessionEngine(config);
  const entries: LogEntry[] = [];
  let at = T0;
  const add = (entry: LogEntry) => {
    const recorded = { ...entry, h: engine.exchange.stateHash() };
    engine.apply(recorded, () => undefined);
    entries.push(recorded);
  };
  const ticks = (count: number) => {
    add({ kind: "ticks", count, from: at + 600, at: at + count * 600 });
    at += count * 600;
  };

  ticks(700);
  add({ kind: "open", accountId: "g_alice", at });
  add({ kind: "command", at, command: buy("g_alice", "ORBT", 30) });
  ticks(450);
  add({ kind: "open", accountId: "g_bob", at });
  add({ kind: "command", at, command: buy("g_bob", "SOLR", 100, "300.00") });
  ticks(1);
  add({ kind: "command", at, command: buy("g_alice", "SOLR", 12) });
  ticks(900);

  return { config, entries, head: { seq: entries.length, stateHash: engine.exchange.stateHash() } };
}

const log = recordSession();
const total = log.entries.reduce((n, e) => n + stepsIn(e), 0);

describe("Replayer", () => {
  it("replays the log to the same state hash as the session that wrote it", () => {
    const replay = new Replayer(log);
    expect(replay.totalSteps).toBe(total);
    expect(replay.verdict).toEqual({ status: "pending" });

    replay.seek(replay.totalSteps);
    expect(replay.verdict).toEqual({
      status: "verified",
      seq: log.entries.length,
      stateHash: log.head.stateHash,
    });
    expect(replay.stateHash()).toBe(log.head.stateHash);
    expect(replay.commands).toBeGreaterThan(total * 50); // every tick is many bot commands
    expect(replay.seq).toBe(log.entries.length);
  });

  it("is deterministic in small chunks too: the verdict does not depend on how it is driven", () => {
    const replay = new Replayer(log, { checkpointEvery: 64 });
    while (replay.position < replay.totalSteps) replay.seek(replay.position + 37);
    expect(replay.verdict.status).toBe("verified");
  });

  it("scrubbing backward and forward gives exactly the frame a straight replay gives", () => {
    const scrubbed = new Replayer(log, { checkpointEvery: 100 });
    scrubbed.seek(scrubbed.totalSteps);

    for (const target of [0, 1, 99, 100, 101, 701, 702, 1_150, 1_337, total - 1, total, 250]) {
      const straight = new Replayer(log, { checkpointEvery: 100_000 });
      straight.seek(target);
      scrubbed.seek(target);
      expect(scrubbed.position).toBe(target);
      expect(scrubbed.stateHash()).toBe(straight.stateHash());
      for (const symbol of ["ORBT", "SOLR"]) {
        expect(scrubbed.frame(symbol)).toEqual(straight.frame(symbol));
      }
    }
    // Rewinding never disturbs a verdict already reached.
    expect(scrubbed.verdict.status).toBe("verified");
  });

  it("builds candles and a newest-first tape from the trades it replays", () => {
    const replay = new Replayer(log);
    replay.seek(700);
    const frame = replay.frame("ORBT");
    expect(frame.candles.length).toBeGreaterThan(10);
    expect(frame.trades.length).toBeGreaterThan(0);
    expect(frame.trades[0]?.price).toBe(frame.last);
    expect(frame.candles.at(-1)?.close).toBe(frame.last);
    expect(frame.depth.bids.length).toBeGreaterThan(0);
    expect(frame.time).toBe(replay.timeAt(700));
    for (const [older, newer] of frame.candles.map((c, i, all) => [all[i - 1], c] as const)) {
      if (older) expect(newer.time).toBeGreaterThan(older.time);
    }
  });

  it("maps positions to session time and log sequence", () => {
    const replay = new Replayer(log);
    const first = log.entries[0];
    if (!first) throw new Error("empty log");
    expect(replay.timeAt(1)).toBe(stepTime(first, 0));
    expect(replay.timeAt(700)).toBe(first.at);
    replay.seek(699);
    expect(replay.seq).toBe(0); // the first entry is not finished
    replay.seek(700);
    expect(replay.seq).toBe(1);
    replay.seek(702);
    expect(replay.seq).toBe(3);
  });

  it.each([
    ["a changed quantity", 2, (e: LogEntry) => withQty(e, 31)],
    ["a dropped tick", 3, (e: LogEntry) => (e.kind === "ticks" ? { ...e, count: e.count - 1 } : e)],
    [
      "a different account",
      4,
      (e: LogEntry) => (e.kind === "open" ? { ...e, accountId: "g_bobby" } : e),
    ],
  ])("pins a divergence caused by %s to the entry that caused it", (_name, index, tamper) => {
    const entries = log.entries.map((e, i) => (i === index ? tamper(e) : e));
    const replay = new Replayer({ ...log, entries });
    replay.seek(replay.totalSteps);
    expect(replay.verdict).toMatchObject({ status: "diverged", seq: index + 1 });
    if (replay.verdict.status === "diverged") {
      expect(replay.verdict.expected).toBe(log.entries[index + 1]?.h);
      expect(replay.verdict.actual).not.toBe(replay.verdict.expected);
    }
  });

  it("reports a different seed as a divergence at the first entry, not at the end", () => {
    const replay = new Replayer({ ...log, config: { ...config, seed: config.seed + 1 } });
    replay.seek(replay.totalSteps);
    expect(replay.verdict).toMatchObject({ status: "diverged", seq: 1 });
  });

  it("falls back to the final hash when entries carry no hashes", () => {
    const bare = log.entries.map((entry) => {
      const copy: LogEntry = { ...entry };
      delete (copy as { h?: string }).h;
      return copy;
    });
    const honest = new Replayer({ ...log, entries: bare });
    honest.seek(honest.totalSteps);
    expect(honest.verdict.status).toBe("verified");

    const tampered = new Replayer({
      ...log,
      entries: bare.map((e, i) => (i === 2 ? withQty(e, 31) : e)),
    });
    tampered.seek(tampered.totalSteps);
    expect(tampered.verdict).toMatchObject({ status: "diverged", seq: log.entries.length });
  });

  it("refuses a log whose length disagrees with the server's sequence", () => {
    expect(() => new Replayer({ ...log, entries: log.entries.slice(1) })).toThrow(/reported/);
  });
});

function withQty(entry: LogEntry, qty: number): LogEntry {
  if (entry.kind !== "command" || entry.command.kind !== "place") return entry;
  return { ...entry, command: { ...entry.command, qty: quantity(qty) } };
}
