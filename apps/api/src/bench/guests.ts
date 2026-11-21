/**
 * What each guest account costs: snapshot bytes and retained heap, for a
 * guest who only opens a session and for guests who trade. Sets the scale of
 * MAX_GUESTS_PER_SESSION. Run with `npm run bench:guests -w @marketlab/api`.
 *
 * Each phase opens `GUESTS` new accounts on top of the last phase's, so the
 * per-guest figures are differences between phases. Heap is measured after a
 * full garbage collection (the script runs with --expose-gc).
 */

import { quantity, type Command } from "@marketlab/engine";

import { EngineHost } from "../host.js";
import { INSTRUMENTS } from "../instruments.js";
import { MemoryLog } from "../log/memory.js";

const GUESTS = 500;

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc (npm run bench:guests does)");

const host = await EngineHost.start({
  log: new MemoryLog(),
  instruments: INSTRUMENTS,
  tickMs: 600,
  sessionMaxAgeMs: 24 * 60 * 60 * 1000,
  seed: 42,
  warmupTicks: 3_000, // the production warm-up: 30 minutes of ticks
  snapshotMs: 0,
});

function measure() {
  gc?.();
  gc?.();
  return {
    snapshotBytes: Buffer.byteLength(host.snapshot().state),
    heapBytes: process.memoryUsage().heapUsed,
  };
}

const symbols = INSTRUMENTS.map((i) => i.symbol);

/** A guest who trades: market orders that fill, and limit orders that rest at the best bid. */
async function trade(accountId: string, orders: number, i: number) {
  for (let n = 0; n < orders; n++) {
    const symbol = symbols[(i + n) % symbols.length] ?? "ORBT";
    const base = { kind: "place", accountId, symbol, qty: quantity(1) } as const;
    const bid = host.exchange.depth(symbol)?.bids[0]?.price;
    const command: Command =
      n % 2 === 1 && bid !== undefined
        ? { ...base, side: "buy", type: "limit", limitPrice: bid }
        : { ...base, side: n % 4 === 0 ? "buy" : "sell", type: "market" };
    await host.submit(command);
    if (n % 5 === 0) host.tick();
  }
}

const rows: { phase: string; snapshotBytes: number; heapBytes: number }[] = [];
let previous = measure();
rows.push({ phase: "no guests (after warm-up)", ...previous });

for (const orders of [0, 10, 50]) {
  const started = performance.now();
  for (let i = 0; i < GUESTS; i++) {
    const id = await host.openGuest();
    await trade(id, orders, i);
  }
  const elapsed = performance.now() - started;
  const now = measure();
  rows.push({
    phase: `+${String(GUESTS)} guests, ${String(orders)} orders each`,
    ...now,
  });
  const perGuest = (bytes: number) => Math.round(bytes / GUESTS);
  const perOrder = orders > 0 ? `, ${(elapsed / (GUESTS * orders)).toFixed(2)} ms/order` : "";
  console.info(
    `${String(orders).padStart(2)} orders/guest: snapshot +${String(perGuest(now.snapshotBytes - previous.snapshotBytes))} B/guest, heap +${String(perGuest(now.heapBytes - previous.heapBytes))} B/guest${perOrder}`,
  );
  previous = now;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
console.table(
  rows.map((r) => ({
    phase: r.phase,
    "snapshot MB": mb(r.snapshotBytes),
    "heap MB": mb(r.heapBytes),
  })),
);
console.info(`audit violations: ${String(host.exchange.audit().length)}`);
