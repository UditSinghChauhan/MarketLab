/**
 * Why a visitor's order takes longer in the engine than the median on
 * /api/health. Run with `npm run bench:latency -w @marketlab/api`.
 *
 * Every number is `exchange.lastUs`, the same measurement the inspector and
 * /api/health report, taken around `Exchange.submit` only. Scenarios:
 *
 * 1. Bot commands while the market ticks, by what they did: cancel, rest
 *    without trading, or cross and trade. This is what the health median is
 *    made of.
 * 2. The visitor's order (market, 5 shares, alternating buy and sell) run
 *    back to back on a hot engine, with no I/O in between; then the same with
 *    the thread sleeping 5 ms before each order, and with it spinning 5 ms.
 * 3. The same order through the host, with an in-memory log that answers at
 *    once (no I/O wait before matching).
 * 4. The same order through the host with a 5 ms asynchronous log write before
 *    matching, like the Postgres append.
 * 5. Like production: the clock ticks every 600 ms and a visitor orders every
 *    300 ms, with the 5 ms write.
 * 6. Each new account's first order compared with its later ones.
 * 7. The cost of the timer itself (two `hrtime.bigint()` calls).
 */

import type { Command, EngineEvent } from "@marketlab/engine";
import { quantity } from "@marketlab/engine";

import { EngineHost } from "../host.js";
import { INSTRUMENTS } from "../instruments.js";
import { MemoryLog } from "../log/memory.js";
import type { LogEntry } from "../log/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A memory log whose appends take `delayMs` of asynchronous wall time, like a network write. */
class SlowLog extends MemoryLog {
  delayMs = 0;
  override async append(sessionId: number, seq: number, entry: LogEntry): Promise<void> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    return super.append(sessionId, seq, entry);
  }
}

function stats(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (v: number) => Math.round(v * 10) / 10;
  return { n: sorted.length, p50: round(at(0.5)), p90: round(at(0.9)), p99: round(at(0.99)) };
}

const visitorOrder = (accountId: string, i: number): Command => ({
  kind: "place",
  accountId,
  symbol: "ORBT",
  side: i % 2 === 0 ? "buy" : "sell",
  type: "market",
  qty: quantity(5),
});

const log = new SlowLog();
const host = await EngineHost.start({
  log,
  instruments: INSTRUMENTS,
  tickMs: 600,
  sessionMaxAgeMs: 24 * 60 * 60 * 1000,
  seed: 42,
  warmupTicks: 3_000, // the production warm-up: 30 minutes of ticks
  snapshotMs: 0,
});
const { exchange } = host;

// Record every engine command with what it did and how long it took.
type Kind = "cancel" | "rests" | "trades" | "other";
let recording: Kind[] | undefined;
const bot: Record<Kind, number[]> = { cancel: [], rests: [], trades: [], other: [] };
const submit = exchange.submit.bind(exchange);
exchange.submit = (command: Command): EngineEvent[] => {
  const events = submit(command);
  if (recording) {
    const kind: Kind =
      command.kind === "cancel"
        ? "cancel"
        : events.some((e) => e.type === "trade")
          ? "trades"
          : events.some((e) => e.type === "order.rested")
            ? "rests"
            : "other";
    bot[kind].push(exchange.lastUs);
  }
  return events;
};

// 1. Bot commands.
recording = [];
for (let i = 0; i < 2_000; i++) host.tick();
recording = undefined;

// 2. The visitor's order, hot, straight into the engine.
const direct = await host.openGuest();
const hot: number[] = [];
for (let i = 0; i < 2_000; i++) {
  exchange.submit(visitorOrder(direct, i));
  hot.push(exchange.lastUs);
  if (i % 10 === 0) host.tick(); // keep the book replenished
}

// 2b. The same, straight into the engine, but the thread sleeps 5 ms before
// each order (an idle wait, like awaiting the network).
const sleptFirst: number[] = [];
for (let i = 0; i < 300; i++) {
  await sleep(5);
  exchange.submit(visitorOrder(direct, i));
  sleptFirst.push(exchange.lastUs);
  if (i % 10 === 0) host.tick();
}

// 2c. The same, but the 5 ms are spent spinning on this thread instead of
// sleeping, so the core never goes idle (and only the spin loop runs meanwhile).
const spunFirst: number[] = [];
for (let i = 0; i < 300; i++) {
  const until = performance.now() + 5;
  while (performance.now() < until) {
    // busy wait
  }
  exchange.submit(visitorOrder(direct, i));
  spunFirst.push(exchange.lastUs);
  if (i % 10 === 0) host.tick();
}

async function throughHost(accountId: string, count: number, gapMs: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const result = await host.submit(visitorOrder(accountId, i));
    out.push(result.timing.engineUs);
    if (gapMs > 0) await sleep(gapMs);
    else host.tick();
  }
  return out;
}

// 3. Through the host, no I/O wait.
const noWait = await throughHost(await host.openGuest(), 500, 0);

// 4. Through the host, 5 ms log write before matching.
log.delayMs = 5;
const afterWrite = await throughHost(await host.openGuest(), 300, 0);

// 5. Like production: ticks every 600 ms, an order every 300 ms.
host.startClock();
const production = await throughHost(await host.openGuest(), 100, 300);

// 6. First order of each new account, then its next nine.
const firsts: number[] = [];
const laters: number[] = [];
for (let a = 0; a < 30; a++) {
  const samples = await throughHost(await host.openGuest(), 10, 300);
  firsts.push(samples[0] ?? 0);
  laters.push(...samples.slice(1));
}
await host.stop();

// 7. Timer overhead.
const timer: number[] = [];
for (let i = 0; i < 100_000; i++) {
  const start = process.hrtime.bigint();
  timer.push(Number(process.hrtime.bigint() - start) / 1_000);
}

const all = [...bot.cancel, ...bot.rests, ...bot.trades, ...bot.other];
const rows = {
  "1. bot commands, all (what /api/health's median is made of)": stats(all),
  "1a. bot: cancel": stats(bot.cancel),
  "1b. bot: rests without trading": stats(bot.rests),
  "1c. bot: crosses and trades": stats(bot.trades),
  "2. visitor order, hot, straight into the engine": stats(hot),
  "2b. same, straight in, after sleeping 5 ms": stats(sleptFirst),
  "2c. same, straight in, after spinning 5 ms (core stays busy)": stats(spunFirst),
  "3. visitor order through the host, no I/O wait": stats(noWait),
  "4. visitor order through the host, after a 5 ms log write": stats(afterWrite),
  "5. like production (600 ms ticks, order every 300 ms, 5 ms write)": stats(production),
  "6a. a new account's first order (production timing)": stats(firsts),
  "6b. that account's next nine orders": stats(laters),
  "7. timer overhead (two hrtime.bigint calls)": stats(timer),
};
console.log(`node ${process.version}, engine time in µs (exchange.lastUs)`);
console.table(rows);
const share = (k: Kind) => `${String(Math.round((bot[k].length / all.length) * 100))} %`;
console.log(
  `bot command mix: cancel ${share("cancel")}, rests ${share("rests")}, trades ${share("trades")}, other ${share("other")}`,
);
