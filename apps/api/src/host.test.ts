import { describe, expect, it, vi } from "vitest";

import { EngineHost, HostUnavailableError } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import type { CommandLog } from "./log/types.js";
import { buy, clock, hostOptions, pgliteLog, sell, startHost } from "./test/fixtures.js";

/** Everything observable about a host, for exact before/after comparison. */
function fingerprint(host: EngineHost, guests: string[]) {
  return {
    seq: host.sequence,
    audit: host.exchange.audit(),
    markets: INSTRUMENTS.map((i) => ({
      depth: host.exchange.depth(i.symbol, 50),
      last: host.exchange.lastPrice(i.symbol),
      candles: host.data.candles(i.symbol),
      tape: host.data.tape(i.symbol, 120),
    })),
    guests: guests.map((g) => ({
      account: host.exchange.accounts.snapshot(g),
      open: host.exchange.openOrders(g),
      orders: host.data.ordersOf(g),
    })),
  };
}

/** A realistic session: guests trade while the market ticks. */
async function playSession(host: EngineHost, advance: (ms: number) => void) {
  const alice = await host.openGuest();
  const bob = await host.openGuest();
  for (let i = 0; i < 40; i++) {
    advance(600);
    host.tick();
    if (i === 5) await host.submit(buy(alice, "ORBT", 30));
    if (i === 9) await host.submit(buy(bob, "SOLR", 100, "317.00"));
    if (i === 14) await host.submit(sell(alice, "ORBT", 10, "1251.00"));
    if (i === 22) await host.submit(buy(bob, "QNTA", 15));
    if (i === 30)
      await host.submit({ kind: "cancel", accountId: bob, orderId: "ord_404" as never });
  }
  await host.stop();
  return [alice, bob];
}

const logs: [string, () => Promise<CommandLog>][] = [
  ["memory", () => Promise.resolve(new MemoryLog())],
  ["postgres (PGlite)", async () => (await pgliteLog()).log],
];

describe.each(logs)("engine host replay (%s log)", (_name, makeLog) => {
  it("rebuilds exactly the same state from the command log", async () => {
    const log = await makeLog();
    const time = clock();
    const original = await startHost(log, time.now);
    const guests = await playSession(original, time.advance);
    const before = fingerprint(original, guests);

    const restarted = await startHost(log, time.now);
    expect(restarted.replay.entries).toBe(original.sequence);
    expect(fingerprint(restarted, guests)).toEqual(before);
    expect(before.audit).toEqual([]);
  });

  it("continues identically after a restart", async () => {
    const log = await makeLog();
    const time = clock();
    const a = await startHost(log, time.now);
    await playSession(a, time.advance);
    const b = await startHost(log, time.now);

    // Both copies now advance the same way: determinism survives the restart.
    for (let i = 0; i < 20; i++) expect(b.tick(time.now())).toEqual(a.tick(time.now()));
  });
});

describe("engine host", () => {
  it("logs ticks as one entry, flushed before the next user command", async () => {
    const log = new MemoryLog();
    const time = clock();
    const host = await startHost(log, time.now);
    const guest = await host.openGuest();
    for (let i = 0; i < 7; i++) host.tick();
    await host.submit(buy(guest, "ORBT", 1));

    const { entries } = await log.openSession(time.now(), Infinity, 1);
    expect(entries.map((e) => e.kind)).toEqual(["open", "ticks", "command"]);
    expect(entries[1]).toMatchObject({ count: 7 });
  });

  it("reports timing and the events a command caused", async () => {
    const time = clock();
    const host = await startHost(new MemoryLog(), time.now);
    host.tick();
    const guest = await host.openGuest();
    const result = await host.submit(buy(guest, "ORBT", 5));

    expect(result.ok).toBe(true);
    expect(result.events.map((e) => e.type)).toContain("trade");
    expect(result.timing.engineUs).toBeGreaterThan(0);
    expect(host.data.trace(result.orderId ?? "")?.timing).toEqual(result.timing);
  });

  it("does not apply a command the log failed to store, and stops accepting work", async () => {
    const log = new MemoryLog();
    const time = clock();
    const onFatal = vi.fn();
    const host = await EngineHost.start({ ...hostOptions(log, time.now), onFatal });
    const guest = await host.openGuest();
    const cashBefore = host.exchange.accounts.snapshot(guest).cash;

    const append = vi.spyOn(log, "append").mockRejectedValue(new Error("disk full"));
    await expect(host.submit(buy(guest, "ORBT", 1, "1200.00"))).rejects.toBeInstanceOf(
      HostUnavailableError,
    );
    expect(host.exchange.accounts.snapshot(guest).cash).toEqual(cashBefore);
    expect(host.healthy).toBe(false);
    expect(onFatal).toHaveBeenCalledOnce();

    append.mockResolvedValue();
    await expect(host.submit(buy(guest, "ORBT", 1))).rejects.toBeInstanceOf(HostUnavailableError);
  });

  it("processes concurrent commands one at a time in arrival order", async () => {
    const time = clock();
    const host = await startHost(new MemoryLog(), time.now);
    host.tick();
    const guest = await host.openGuest();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => host.submit(buy(guest, "SOLR", 1, String(300 + i)))),
    );
    const seqs = results.map((r) => r.events[0]?.seq ?? 0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(host.exchange.audit()).toEqual([]);
  });
});
