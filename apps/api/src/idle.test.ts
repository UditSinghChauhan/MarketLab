/**
 * Idle-aware persistence (docs/adr/0007-idle-aware-persistence.md): with no
 * stream client and no user activity for five minutes, the host stops its
 * periodic writes and suspends the log; activity brings both back, and replay
 * stays exact throughout. The market clock is driven by hand with a fake clock.
 */

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  EngineHost,
  HostUnavailableError,
  IDLE_AFTER_MS,
  SessionEndedError,
  type HostOptions,
} from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { LogHeadMovedError, type CommandLog } from "./log/types.js";
import { StreamHub } from "./stream.js";
import { CountingLog, buy, clock, hostOptions, pgliteLog, testConfig } from "./test/fixtures.js";

const TICK_MS = 600;
const MINUTE = 60_000;
const SNAPSHOT_MS = 10 * MINUTE;

/** A host on `log` with snapshots on, and a `beat` that advances the fake clock one tick at a time. */
async function setup(log: CommandLog = new CountingLog(), extra: Partial<HostOptions> = {}) {
  const time = clock();
  const options: HostOptions = { ...hostOptions(log, time.now), snapshotMs: SNAPSHOT_MS, ...extra };
  const host = await EngineHost.start(options);
  const beat = async (ms: number) => {
    for (let t = 0; t < ms; t += TICK_MS) {
      time.advance(TICK_MS);
      await host.clockTick();
    }
  };
  return { host, time, beat, options };
}

/** Beats until the host has gone idle and suspended its log. */
async function goIdle(host: EngineHost, beat: (ms: number) => Promise<void>, log: CommandLog) {
  await beat(IDLE_AFTER_MS + TICK_MS);
  expect(host.active).toBe(false);
  expect(log.connected).toBe(false);
}

describe("idle-aware persistence", () => {
  it("writes nothing to the log while nobody watches or trades", async () => {
    const log = new CountingLog();
    const { host, beat } = await setup(log);

    // Active for five minutes after the start: ticks are flushed every 30 seconds.
    await beat(IDLE_AFTER_MS - TICK_MS);
    expect(host.active).toBe(true);
    expect(log.appends).toBeGreaterThanOrEqual(9);

    // Going idle: one last flush and one snapshot, then the log is suspended...
    const before = log.writes();
    await goIdle(host, beat, log);
    expect(log.writes()).toEqual({ appends: before.appends + 1, snapshots: before.snapshots + 1 });

    // ...and ten more minutes of market ticks write nothing at all.
    const idle = log.writes();
    const seq = host.sequence;
    await beat(10 * MINUTE);
    expect(log.writes()).toEqual(idle);
    expect(host.sequence).toBe(seq);
    expect(log.connected).toBe(false);
  });

  it("resumes writing when a client connects, with a snapshot straight away", async () => {
    const log = new CountingLog();
    const { host, beat, options } = await setup(log);
    await goIdle(host, beat, log);
    await beat(10 * MINUTE);
    const idle = log.writes();

    let watchers = 0;
    host.watch(() => watchers);
    watchers = 1;
    await beat(TICK_MS);
    expect(log.connected).toBe(true);
    // The idle ticks as one entry, then a snapshot after it.
    expect(log.writes()).toEqual({ appends: idle.appends + 1, snapshots: idle.snapshots + 1 });
    const { entries } = await log.openSession(0, Infinity, 1);
    // The beat after going idle, ten idle minutes, and the beat that woke it.
    const idleTicks = 1 + (10 * MINUTE) / TICK_MS + 1;
    expect(entries.at(-1)).toMatchObject({ kind: "ticks", count: idleTicks });

    // Periodic flushes are back.
    await beat(MINUTE);
    expect(log.appends).toBeGreaterThan(idle.appends + 1);

    // A restart right after waking restores that snapshot instead of replaying the idle ticks.
    await host.stop();
    const restarted = await EngineHost.start(options);
    expect(restarted.replay.entries).toBeLessThanOrEqual(1);
    expect(restarted.exchange.stateHash()).toBe(host.exchange.stateHash());
  });

  it("replays an idle stretch exactly, from the full log and from the snapshot", async () => {
    const log = new CountingLog();
    const { host, beat, options } = await setup(log);
    const guest = await host.openGuest();
    await host.submit(buy(guest, "ORBT", 5));
    await goIdle(host, beat, log);
    await beat(7 * MINUTE);

    const checkpoint = await host.checkpoint(); // logs the idle ticks, as a replay does
    const full = await EngineHost.start({ ...options, snapshotMs: 0 });
    expect(full.replay.snapshotSeq).toBe(0);
    expect(full.exchange.stateHash()).toBe(checkpoint.stateHash);
    expect(full.sequence).toBe(checkpoint.seq);

    const fromSnapshot = await EngineHost.start(options);
    expect(fromSnapshot.replay.snapshotSeq).toBeGreaterThan(0);
    expect(fromSnapshot.exchange.stateHash()).toBe(checkpoint.stateHash);
  });

  it("still logs the idle ticks before a user command, then the command", async () => {
    const log = new CountingLog();
    const { host, beat, options } = await setup(log);
    const guest = await host.openGuest();
    await goIdle(host, beat, log);
    await beat(2 * MINUTE);

    await host.submit(buy(guest, "SOLR", 3));
    expect(log.connected).toBe(true);
    const { entries } = await log.openSession(0, Infinity, 1);
    expect(entries.slice(-2).map((e) => e.kind)).toEqual(["ticks", "command"]);
    // The beat after going idle, then two idle minutes.
    expect(entries.at(-2)).toMatchObject({ count: 1 + (2 * MINUTE) / TICK_MS });

    const restarted = await EngineHost.start({ ...options, snapshotMs: 0 });
    expect(restarted.exchange.stateHash()).toBe(host.exchange.stateHash());
  });

  it("goes idle on schedule however often /api/health is called", async () => {
    const log = new CountingLog();
    const { host, beat } = await setup(log);
    const app = await buildApp({
      config: testConfig(),
      host,
      hub: new StreamHub(host, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
    const pollHealth = async (ms: number) => {
      for (let t = 0; t < ms; t += 10_000) {
        expect((await app.inject("/api/health")).statusCode).toBe(200);
        await beat(10_000);
      }
    };

    await pollHealth(IDLE_AFTER_MS + 10_000);
    expect(log.connected).toBe(false);
    const idle = log.writes();
    await pollHealth(5 * MINUTE);
    expect(log.writes()).toEqual(idle);
    await app.close();
  });

  it("answers /api/health without touching the database", async () => {
    const log = new GuardedLog();
    const { host } = await setup(log);
    host.tick();
    log.armed = true; // from here on, any use of the log is recorded and fails

    const app = await buildApp({
      config: testConfig(),
      host,
      hub: new StreamHub(host, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
    const res = await app.inject("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", invariantViolations: 0 });
    expect(log.touched).toEqual([]);
    await app.close();
  });

  it("reconnects for a replay read while suspended, then suspends again five minutes later", async () => {
    const log = new CountingLog();
    const { host, beat } = await setup(log);
    await goIdle(host, beat, log);

    expect((await host.readEntries(0, 10)).length).toBeGreaterThan(0);
    expect(log.connected).toBe(true);
    await beat(IDLE_AFTER_MS - 2 * TICK_MS);
    expect(log.connected).toBe(true); // the read counts as activity
    await beat(3 * TICK_MS);
    expect(log.connected).toBe(false);
  });
});

/** A log that can hold its next `openSession` until released: a known point inside a rollover. */
class GatedLog extends CountingLog {
  private next: { reached: () => void; gate: Promise<void> } | undefined;

  holdNextSession(): { reached: Promise<void>; release: () => void } {
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.next = { reached, gate };
    return { reached: reachedPromise, release };
  }

  override async openSession(...args: Parameters<CountingLog["openSession"]>) {
    const next = this.next;
    this.next = undefined;
    if (next) {
      next.reached();
      await next.gate;
    }
    return super.openSession(...args);
  }
}

describe("session rollover", () => {
  const MAX_AGE = 20 * MINUTE;
  const DAY = 24 * 60 * MINUTE;

  /** A host whose sessions last MAX_AGE, recording its lifecycle events. */
  async function aging(log: CountingLog = new CountingLog(), extra: Partial<HostOptions> = {}) {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const context = await setup(log, {
      sessionMaxAgeMs: MAX_AGE,
      warmupTicks: 50,
      onEvent: (event, fields) => events.push({ event, fields: { ...fields } }),
      ...extra,
    });
    return { ...context, events };
  }

  it("waits while anyone watches or has just acted, then rolls over once idle", async () => {
    const { host, time, beat } = await aging();
    let watchers = 1;
    host.watch(() => watchers);
    time.advance(MAX_AGE);
    await beat(TICK_MS);
    expect(host.session.id).toBe(1); // watched: never

    watchers = 0;
    await host.openGuest(); // someone acted just now
    await beat(IDLE_AFTER_MS - 2 * TICK_MS);
    expect(host.session.id).toBe(1);
    await beat(3 * TICK_MS); // idle from here
    expect(host.session.id).toBe(2);
  });

  it("ends an idle session in place: the old log is kept as it was, the new session replays exactly", async () => {
    const log = new CountingLog();
    const { host, time, beat, options, events } = await aging(log);
    const guest = await host.openGuest();
    await host.submit(buy(guest, "ORBT", 5));
    await goIdle(host, beat, log);
    time.advance(MAX_AGE);
    await beat(TICK_MS); // this beat rolls the session over

    const rolled = events.find((e) => e.event === "session_rolled_over")?.fields;
    expect(rolled).toMatchObject({ from: 1, session: 2, seq: 1, warmupTicks: 50 });
    // The old session ends with its idle ticks, and a snapshot at its last entry.
    const oldEntries = await log.readEntries(1, 0, 100_000);
    expect(oldEntries.length).toBe(rolled?.fromSeq);
    expect(oldEntries.at(-1)).toMatchObject({ kind: "ticks" });
    expect((await log.loadSnapshot(1))?.seq).toBe(oldEntries.length);

    // Nothing carries over: accounts, orders, read models, latency windows.
    expect(host.session.id).toBe(2);
    expect(host.exchange.accounts.has(guest)).toBe(false);
    expect(host.data.humanCount).toBe(0);
    expect(host.data.ordersOf(guest)).toEqual([]);
    expect(host.exchange.visitors.summary().samples).toBe(0);
    expect(host.exchange.audit()).toEqual([]);
    // The warm-up is logged as one entry, with a snapshot after it at once.
    expect((await log.readEntries(2, 0, 10)).map((e) => e.kind)).toEqual(["ticks"]);
    expect((await log.loadSnapshot(2))?.seq).toBe(1);

    // The new session is played, then the process restarts: it resumes the
    // new session and reaches the same state, from the whole log or a snapshot.
    const fresh = await host.openGuest();
    await host.submit(buy(fresh, "SOLR", 2));
    await host.stop();
    for (const snapshotMs of [0, SNAPSHOT_MS]) {
      const restarted = await EngineHost.start({ ...options, snapshotMs });
      expect(restarted.session.id).toBe(2);
      expect(restarted.exchange.stateHash()).toBe(host.exchange.stateHash());
    }
    expect(await log.readEntries(1, 0, 100_000)).toEqual(oldEntries); // untouched
  });

  it("refuses, unlogged, a command that waited behind the rollover", async () => {
    const log = new GatedLog();
    const { host, time, beat } = await aging(log);
    const guest = await host.openGuest();
    await goIdle(host, beat, log);
    time.advance(MAX_AGE);

    const held = log.holdNextSession();
    const rolling = host.clockTick();
    await held.reached; // inside the rollover: the old session is closed, the new one not open
    const queued = host.submit(buy(guest, "ORBT", 1)); // its token checked out a moment ago
    held.release();
    await rolling;

    await expect(queued).rejects.toBeInstanceOf(SessionEndedError);
    expect(host.session.id).toBe(2);
    expect((await log.readEntries(2, 0, 10)).map((e) => e.kind)).toEqual(["ticks"]);
  });

  it("answers such a command with 401 session_expired", async () => {
    const { host } = await aging();
    const app = await buildApp({
      config: testConfig(),
      host,
      hub: new StreamHub(host, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
    const { token } = (await app.inject({ method: "POST", url: "/api/session" })).json<{
      token: string;
    }>();
    vi.spyOn(host, "submit").mockRejectedValue(new SessionEndedError("ended"));
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { authorization: `Bearer ${token}` },
      payload: { symbol: "ORBT", side: "buy", type: "market", qty: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "session_expired" } });
    await app.close();
  });

  it("ends a stream that connected during the rollover, before its account is gone", async () => {
    const log = new GatedLog();
    const { host, time, beat } = await aging(log);
    const hub = new StreamHub(host, INSTRUMENTS, { marketsIntervalMs: 20 });
    host.watch(() => hub.size);
    hub.start();
    const app = await buildApp({
      config: testConfig(),
      host,
      hub,
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const base = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;
    try {
      const { token } = (await app.inject({ method: "POST", url: "/api/session" })).json<{
        token: string;
      }>();
      await goIdle(host, beat, log);
      time.advance(MAX_AGE);

      const held = log.holdNextSession();
      const rolling = host.clockTick();
      await held.reached;
      // A returning visitor opens the terminal right now: the old session still holds.
      const stream = await fetch(`${base}/api/stream?symbol=ORBT&token=${token}`);
      expect(stream.status).toBe(200);
      expect(hub.size).toBe(1);
      held.release();
      await rolling;

      // The server ended it (the browser reconnects and is told its session ended).
      expect(hub.size).toBe(0);
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
      const ended = async () => {
        for (;;) if ((await reader.read()).done) return true;
      };
      await expect(ended()).resolves.toBe(true);
      // Market pushes keep running (every 20 ms) without touching the old account.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(host.healthy).toBe(true);
    } finally {
      hub.stop();
      await app.close();
    }
  });

  it("deletes sessions that started more than seven days before", async () => {
    const log = new CountingLog();
    const { host, time, beat } = await aging(log, { sessionMaxAgeMs: 3 * DAY });
    for (let i = 0; i < 3; i++) {
      time.advance(3 * DAY);
      await beat(TICK_MS);
    }
    expect(host.session.id).toBe(4); // sessions began at days 0, 3, 6 and 9
    expect(await log.readEntries(1, 0, 10)).toEqual([]);
    expect(await log.loadSnapshot(1)).toBeNull();
    expect((await log.readEntries(2, 0, 10)).length).toBeGreaterThan(0); // six days old
  });
});

describe("idle-aware persistence on PostgreSQL (PGlite)", () => {
  it("suspends and resumes, and replays to the same state", async () => {
    const { log } = await pgliteLog();
    const { host, beat, options } = await setup(log);
    await goIdle(host, beat, log);
    await beat(3 * MINUTE);

    host.watch(() => 1);
    await beat(MINUTE);
    expect(log.connected).toBe(true);
    await host.stop();

    const restarted = await EngineHost.start({ ...options, snapshotMs: 0 });
    expect(restarted.exchange.stateHash()).toBe(host.exchange.stateHash());
  });

  it("stands down, without failing, if another writer added to the session while it was idle", async () => {
    const { log } = await pgliteLog();
    const onFatal = vi.fn();
    const onSuperseded = vi.fn();
    const { host, beat } = await setup(log, { onFatal, onSuperseded });
    await goIdle(host, beat, log);
    // Another process appends while this one holds no lock.
    await log.append(host.session.id, host.sequence + 1, {
      kind: "ticks",
      count: 1,
      from: 0,
      at: 0,
    });

    host.watch(() => 1);
    const seq = host.sequence;
    await beat(TICK_MS); // waking: resume finds the log changed
    expect(onSuperseded).toHaveBeenCalledOnce();
    expect(onSuperseded.mock.calls[0]?.[0]).toBeInstanceOf(LogHeadMovedError);
    expect(onFatal).not.toHaveBeenCalled();
    expect(host.superseded).toBe(true);
    expect(host.sequence).toBe(seq); // it wrote nothing...
    await beat(10 * TICK_MS);
    expect(host.sequence).toBe(seq); // ...and never tries again
    await expect(host.openGuest()).rejects.toThrow(HostUnavailableError);
    expect(await host.stop()).toBe("owned-elsewhere");
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("on shutdown, skips the final flush without failing if another writer took over while idle", async () => {
    const { log } = await pgliteLog();
    const onFatal = vi.fn();
    const { host, beat } = await setup(log, { onFatal });
    await goIdle(host, beat, log);
    await beat(MINUTE); // idle ticks this process will not get to log
    await log.append(host.session.id, host.sequence + 1, {
      kind: "ticks",
      count: 1,
      from: 0,
      at: 0,
    });

    const seq = host.sequence;
    expect(await host.stop()).toBe("owned-elsewhere");
    expect(onFatal).not.toHaveBeenCalled();
    expect(host.sequence).toBe(seq);
    const { entries } = await log.openSession(0, Infinity, 1);
    expect(entries).toHaveLength(seq + 1); // only the other writer's entry was added
  });
});

/** A log that, once armed, records and refuses every use. */
class GuardedLog extends CountingLog {
  armed = false;
  readonly touched: string[] = [];

  private guard(method: string): void {
    if (!this.armed) return;
    this.touched.push(method);
    throw new Error(`the log was used: ${method}`);
  }

  override openSession(...args: Parameters<CountingLog["openSession"]>) {
    this.guard("openSession");
    return super.openSession(...args);
  }
  override append(...args: Parameters<CountingLog["append"]>) {
    this.guard("append");
    return super.append(...args);
  }
  override readEntries(...args: Parameters<CountingLog["readEntries"]>) {
    this.guard("readEntries");
    return super.readEntries(...args);
  }
  override loadSnapshot(...args: Parameters<CountingLog["loadSnapshot"]>) {
    this.guard("loadSnapshot");
    return super.loadSnapshot(...args);
  }
  override saveSnapshot(...args: Parameters<CountingLog["saveSnapshot"]>) {
    this.guard("saveSnapshot");
    return super.saveSnapshot(...args);
  }
  override suspend() {
    this.guard("suspend");
    return super.suspend();
  }
  override resume(...args: Parameters<CountingLog["resume"]>) {
    this.guard("resume");
    return super.resume(...args);
  }
}
