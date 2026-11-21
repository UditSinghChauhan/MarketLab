import { randomUUID } from "node:crypto";

import { CLIENT_ORDER_IDS_PER_ACCOUNT, type Command } from "@marketlab/engine";
import { describe, expect, it, vi } from "vitest";

import {
  ClientOrderIdReusedError,
  EngineHost,
  GuestLimitError,
  HostUnavailableError,
} from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import type { CommandLog } from "./log/types.js";
import { MAX_ORDERS_PER_ACCOUNT } from "./market-data.js";
import { buy, clock, hostOptions, pgliteLog, sell, startHost } from "./test/fixtures.js";

/** Everything observable about a host, for exact before/after comparison. */
function fingerprint(host: EngineHost, guests: string[]) {
  return {
    seq: host.sequence,
    hash: host.exchange.stateHash(),
    stats: host.stats().commands,
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
      // Request timings live only in the process that served the request.
      traces: host.data.ordersOf(g).map((o) => ({ ...host.data.trace(o.id), timing: null })),
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

/** A command carrying a client order id. */
function withId(command: Command, clientOrderId: string = randomUUID()): Command {
  if (command.kind !== "place") throw new Error("only a place command takes a client order id");
  return { ...command, clientOrderId };
}

describe.each(logs)("client order ids (%s log)", (_name, makeLog) => {
  it("answers a retry with the first outcome, and logs nothing for it", async () => {
    const time = clock();
    const host = await startHost(await makeLog(), time.now);
    host.tick();
    const guest = await host.openGuest();

    const order = withId(buy(guest, "ORBT", 3, "1200.00"));
    const first = await host.submit(order);
    expect(first).toMatchObject({ ok: true });
    expect(first.replayed).toBeUndefined();
    const logged = host.sequence;
    const cash = host.exchange.accounts.snapshot(guest).cash;

    const retry = await host.submit(order);
    expect(retry).toMatchObject({
      ok: true,
      orderId: first.orderId,
      rejectReason: null,
      events: [],
      replayed: true,
      order: host.data.order(first.orderId ?? ""),
    });
    expect(retry.order).toMatchObject({ id: first.orderId, qty: 3, status: "resting" });
    expect(host.sequence).toBe(logged);
    expect(host.exchange.accounts.snapshot(guest).cash).toEqual(cash);
    expect(host.data.ordersOf(guest)).toHaveLength(1);

    // A refused order is remembered too: the retry is refused the same way.
    const tooMany = withId(sell(guest, "ORBT", 50, "1300.00"));
    expect(await host.submit(tooMany)).toMatchObject({ ok: false });
    expect(await host.submit(tooMany)).toMatchObject({
      ok: false,
      orderId: null,
      rejectReason: "insufficient_shares",
      replayed: true,
      order: null,
    });
    expect(host.sequence).toBe(logged + 1);
  });

  it("refuses an id reused for a different order, logging nothing", async () => {
    const time = clock();
    const host = await startHost(await makeLog(), time.now);
    const guest = await host.openGuest();
    const id = randomUUID();
    await host.submit(withId(buy(guest, "ORBT", 3, "1200.00"), id));
    const logged = host.sequence;
    await expect(host.submit(withId(buy(guest, "ORBT", 4, "1200.00"), id))).rejects.toBeInstanceOf(
      ClientOrderIdReusedError,
    );
    expect(host.sequence).toBe(logged);
    // The same id from another account is a different order.
    const other = await host.openGuest();
    expect((await host.submit(withId(buy(other, "ORBT", 4, "1200.00"), id))).replayed).toBe(
      undefined,
    );
  });

  it("places once when the retry arrives while the first request is still queued", async () => {
    const time = clock();
    const host = await startHost(await makeLog(), time.now);
    host.tick();
    const guest = await host.openGuest();
    const order = withId(buy(guest, "SOLR", 2, "300.00"));
    const [first, second] = await Promise.all([host.submit(order), host.submit(order)]);
    expect(first.replayed).toBeUndefined();
    expect(second).toMatchObject({ replayed: true, orderId: first.orderId });
    expect(host.data.ordersOf(guest)).toHaveLength(1);
  });

  it("still recognises an id after a restart, from the whole log and from a snapshot", async () => {
    const log = await makeLog();
    const time = clock();
    const options = { ...hostOptions(log, time.now), snapshotMs: 10 * 60_000 };
    const first = await EngineHost.start(options);
    first.tick();
    const guest = await first.openGuest();
    const order = withId(buy(guest, "ORBT", 3, "1200.00"));
    const placed = await first.submit(order);
    await first.stop(); // stores a snapshot at the head
    const head = first.sequence;

    const fromSnapshot = await EngineHost.start(options);
    expect(fromSnapshot.replay).toMatchObject({ snapshotSeq: head, entries: 0 });
    const fullReplay = await EngineHost.start({ ...options, snapshotMs: 0 });
    expect(fullReplay.replay).toMatchObject({ snapshotSeq: 0, entries: head });
    expect(fromSnapshot.exchange.stateHash()).toBe(fullReplay.exchange.stateHash());

    for (const restarted of [fromSnapshot, fullReplay]) {
      expect(await restarted.submit(order)).toMatchObject({
        replayed: true,
        orderId: placed.orderId,
      });
      expect(restarted.sequence).toBe(head);
    }
  });
});

describe("client order ids beyond the order history", () => {
  it("recognise a retry whose order has left the read model: replayed, order null, nothing placed or logged", async () => {
    // The read model keeps fewer orders than the engine keeps ids, so this is reachable.
    expect(MAX_ORDERS_PER_ACCOUNT).toBeLessThan(CLIENT_ORDER_IDS_PER_ACCOUNT);
    const log = new MemoryLog();
    const time = clock();
    const options = { ...hostOptions(log, time.now), snapshotMs: 0 };
    const host = await EngineHost.start(options);
    const guest = await host.openGuest();

    const original = withId(buy(guest, "ORBT", 1, "1.00"));
    const first = await host.submit(original);
    expect(first).toMatchObject({ ok: true, rejectReason: null });
    const orderId = first.orderId ?? "";
    for (let i = 0; i < MAX_ORDERS_PER_ACCOUNT; i++) {
      expect(await host.submit(withId(buy(guest, "ORBT", 1, "1.00")))).toMatchObject({ ok: true });
    }

    // The view is gone; the engine still remembers the id, and the order itself still rests.
    expect(host.data.order(orderId)).toBeUndefined();
    expect(host.data.ordersOf(guest)).toHaveLength(MAX_ORDERS_PER_ACCOUNT);
    expect(
      host.exchange.clientOrder(guest, (original as { clientOrderId: string }).clientOrderId),
    ).toMatchObject({ orderId, rejectReason: null });
    const open = host.exchange.openOrders(guest).length;
    expect(open).toBe(MAX_ORDERS_PER_ACCOUNT + 1);

    const logged = host.sequence;
    const hash = host.exchange.stateHash();
    const retry = await host.submit(original);
    expect(retry).toMatchObject({
      ok: true,
      orderId,
      rejectReason: null,
      events: [],
      replayed: true,
      order: null,
    });
    expect(host.sequence).toBe(logged);
    expect(host.exchange.stateHash()).toBe(hash);
    expect(host.exchange.openOrders(guest)).toHaveLength(open);

    // A rejected order takes an id slot but never enters the order history.
    const refused = withId(sell(guest, "ORBT", 1_000_000, "1300.00"));
    expect(await host.submit(refused)).toMatchObject({ ok: false });
    expect(host.data.ordersOf(guest)).toHaveLength(MAX_ORDERS_PER_ACCOUNT);
    expect(await host.submit(refused)).toMatchObject({
      ok: false,
      orderId: null,
      rejectReason: "insufficient_shares",
      replayed: true,
      order: null,
    });
    await host.stop();

    // Replaying the whole log evicts the same view and remembers the same id.
    const restarted = await EngineHost.start(options);
    expect(restarted.exchange.stateHash()).toBe(host.exchange.stateHash());
    expect(await restarted.submit(original)).toMatchObject({
      ok: true,
      orderId,
      replayed: true,
      order: null,
    });
    expect(restarted.sequence).toBe(host.sequence);
  });
});

describe("engine host", () => {
  it("warms a new session up with backdated history, logged once and replayed exactly", async () => {
    const log = new MemoryLog();
    const time = clock();
    const options = { ...hostOptions(log, time.now), warmupTicks: 100 };
    const first = await EngineHost.start(options);

    const { entries } = await log.openSession(time.now(), Infinity, 1);
    expect(entries).toEqual([
      {
        kind: "ticks",
        count: 100,
        from: time.now() - 99 * 600,
        at: time.now(),
        // The state the ticks were applied to: here, the untouched opening market.
        h: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
      },
    ]);
    expect(first.data.candles("ORBT").length).toBeGreaterThan(1);

    const second = await EngineHost.start(options); // existing session: no second warm-up
    expect(second.replay.entries).toBe(1);
    expect(fingerprint(second, [])).toEqual(fingerprint(first, []));
  });

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

  it("refuses guests past maxGuests without logging them; a restart replays every guest logged", async () => {
    const log = new MemoryLog();
    const time = clock();
    const options = { ...hostOptions(log, time.now), maxGuests: 2 };
    const host = await EngineHost.start(options);
    const guests = [await host.openGuest(), await host.openGuest()];
    const seq = host.sequence;
    const all = Array.from({ length: 3 }, () => host.openGuest());
    for (const refused of await Promise.allSettled(all)) {
      expect(refused.status).toBe("rejected");
      if (refused.status === "rejected") expect(refused.reason).toBeInstanceOf(GuestLimitError);
    }
    expect(host.sequence).toBe(seq);
    expect((await log.readEntries(host.session.id, 0, 100)).length).toBe(seq);

    // The limit lowered between deploys: the guests already in the log are kept.
    const restarted = await EngineHost.start({ ...options, maxGuests: 1 });
    for (const guest of guests) expect(restarted.exchange.accounts.has(guest)).toBe(true);
    await expect(restarted.openGuest()).rejects.toBeInstanceOf(GuestLimitError);
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

  it("reports bot and visitor engine times apart, without replayed commands as visitors", async () => {
    const log = new MemoryLog();
    const time = clock();
    const host = await startHost(log, time.now);
    for (let i = 0; i < 3; i++) host.tick();
    const ticksOnly = host.stats();
    expect(ticksOnly.bots.samples).toBe(ticksOnly.commands);
    expect(ticksOnly.visitors).toEqual({ p50Us: 0, p99Us: 0, samples: 0 });

    const guest = await host.openGuest();
    const result = await host.submit(buy(guest, "ORBT", 5));
    const after = host.stats();
    expect(after.visitors.samples).toBe(1);
    expect(after.visitors.p50Us).toBe(result.timing.engineUs);
    expect(after.bots.samples).toBe(ticksOnly.bots.samples); // the command was not counted twice

    // After a restart the same command is replayed from the log: engine work,
    // but not a visitor's order measured live.
    const restarted = await startHost(log, time.now);
    expect(restarted.stats().visitors.samples).toBe(0);
    expect(restarted.stats().bots.samples).toBe(restarted.stats().commands);
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

const MINUTE = 60_000;

/** A session long enough to cross snapshot intervals: guests trade before and after each one. */
async function playLongSession(host: EngineHost, advance: (ms: number) => void) {
  const alice = await host.openGuest();
  const bob = await host.openGuest();
  for (let minute = 0; minute < 25; minute++) {
    for (let i = 0; i < 20; i++) {
      advance(MINUTE / 20);
      host.tick();
    }
    if (minute === 2) await host.submit(buy(alice, "ORBT", 30));
    if (minute === 4) await host.submit(buy(bob, "SOLR", 100, "300.00"));
    if (minute === 12) await host.submit(sell(alice, "ORBT", 10, "1300.00"));
    if (minute === 13) await host.submit(buy(bob, "QNTA", 15));
    if (minute === 22) await host.submit(buy(alice, "HLXB", 2));
    if (minute === 23) {
      const open = host.data.ordersOf(bob).find((o) => o.status === "resting");
      if (open) await host.submit({ kind: "cancel", accountId: bob, orderId: open.id as never });
    }
  }
  return [alice, bob];
}

describe.each(logs)("engine snapshots (%s log)", (_name, makeLog) => {
  it("restoring a snapshot and replaying the tail equals replaying the whole log", async () => {
    const log = await makeLog();
    const time = clock();
    const withSnapshots = { ...hostOptions(log, time.now), snapshotMs: 10 * MINUTE };
    const original = await EngineHost.start(withSnapshots);
    const guests = await playLongSession(original, time.advance);
    await original.serial(() => original.flush()); // log everything, without a final snapshot
    const expected = fingerprint(original, guests);

    const fromSnapshot = await EngineHost.start(withSnapshots);
    const fullReplay = await EngineHost.start({ ...withSnapshots, snapshotMs: 0 });

    // The snapshot was really used, and it shortened the replay.
    expect(fromSnapshot.replay.snapshotSeq).toBeGreaterThan(0);
    expect(fromSnapshot.replay.entries).toBeLessThan(fullReplay.replay.entries);
    expect(fullReplay.replay).toMatchObject({ snapshotSeq: 0, entries: original.sequence });

    expect(fingerprint(fullReplay, guests)).toEqual(expected);
    expect(fingerprint(fromSnapshot, guests)).toEqual(fingerprint(fullReplay, guests));
    expect(expected.audit).toEqual([]);

    // And both copies go on to produce the same market.
    for (let i = 0; i < 30; i++) {
      expect(fromSnapshot.tick(time.now())).toEqual(fullReplay.tick(time.now()));
    }
    expect(fromSnapshot.exchange.stateHash()).toBe(fullReplay.exchange.stateHash());
  });

  it("stores a snapshot on shutdown, so the next start replays nothing", async () => {
    const log = await makeLog();
    const time = clock();
    const options = { ...hostOptions(log, time.now), snapshotMs: 10 * MINUTE };
    const first = await EngineHost.start(options);
    const guests = await playSession(first, time.advance); // ends with stop()

    const second = await EngineHost.start(options);
    expect(second.replay).toMatchObject({ entries: 0, snapshotSeq: first.sequence });
    expect(second.exchange.stateHash()).toBe(first.exchange.stateHash());
    expect(second.data.ordersOf(guests[0] ?? "")).toHaveLength(2);
  });
});

describe("engine snapshots", () => {
  async function sessionWithSnapshot() {
    const log = new MemoryLog();
    const time = clock();
    const onWarning = vi.fn();
    const options = { ...hostOptions(log, time.now), snapshotMs: 10 * MINUTE, onWarning };
    const first = await EngineHost.start(options);
    const guests = await playSession(first, time.advance);
    const stored = await log.loadSnapshot(first.session.id);
    if (!stored) throw new Error("No snapshot was stored");
    return { log, options, first, guests, stored, onWarning, time };
  }

  it.each([
    [
      "a hash that does not match",
      (s: { stateHash: string }) => ({ ...s, stateHash: "0".repeat(16) }),
    ],
    ["unreadable state", (s: { state: string }) => ({ ...s, state: "{not json" })],
    ["a sequence ahead of the log", (s: { seq: number }) => ({ ...s, seq: s.seq + 5 })],
    [
      "tampered balances",
      (s: { state: string }) => ({
        ...s,
        state: s.state.replace(/"cash":\[(\d+),/, '"cash":[1$1,'),
      }),
    ],
  ])("ignores a snapshot with %s and replays the whole log", async (_name, corrupt) => {
    const { log, options, first, guests, stored, onWarning } = await sessionWithSnapshot();
    await log.saveSnapshot(first.session.id, { ...stored, ...corrupt(stored) });

    const restarted = await EngineHost.start(options);
    expect(onWarning).toHaveBeenCalledOnce();
    expect(restarted.replay).toMatchObject({ snapshotSeq: 0, entries: first.sequence });
    expect(restarted.exchange.stateHash()).toBe(first.exchange.stateHash());
    expect(restarted.data.ordersOf(guests[0] ?? "")).toHaveLength(2);
  });

  it("keeps running when a snapshot cannot be stored", async () => {
    const log = new MemoryLog();
    const time = clock();
    const onWarning = vi.fn();
    const onFatal = vi.fn();
    vi.spyOn(log, "saveSnapshot").mockRejectedValue(new Error("disk full"));
    const host = await EngineHost.start({
      ...hostOptions(log, time.now),
      snapshotMs: MINUTE,
      onWarning,
      onFatal,
    });
    const guest = await host.openGuest();
    time.advance(2 * MINUTE);
    host.tick();
    const result = await host.submit(buy(guest, "ORBT", 1));

    expect(result.ok).toBe(true);
    expect(host.healthy).toBe(true);
    expect(onFatal).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("snapshot"), expect.any(Error));
  });

  it("takes snapshots on the configured interval, and none when turned off", async () => {
    const log = new MemoryLog();
    const time = clock();
    const save = vi.spyOn(log, "saveSnapshot");
    const host = await EngineHost.start({ ...hostOptions(log, time.now), snapshotMs: 5 * MINUTE });
    const guest = await host.openGuest();
    for (let minute = 1; minute <= 12; minute++) {
      time.advance(MINUTE);
      host.tick();
      await host.submit(buy(guest, "SOLR", 1));
    }
    expect(save).toHaveBeenCalledTimes(2); // at minutes 5 and 10

    const off = new MemoryLog();
    const quiet = vi.spyOn(off, "saveSnapshot");
    const other = await startHost(off, time.now);
    await playSession(other, time.advance);
    expect(quiet).not.toHaveBeenCalled();
  });
});
