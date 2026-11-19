/**
 * Idle-aware persistence (docs/adr/0007-idle-aware-persistence.md): with no
 * stream client and no user activity for five minutes, the host stops its
 * periodic writes and suspends the log; activity brings both back, and replay
 * stays exact throughout. The market clock is driven by hand with a fake clock.
 */

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { EngineHost, IDLE_AFTER_MS, type HostOptions } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import type { CommandLog } from "./log/types.js";
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

  it("keeps an idle session past its age until restart, then starts a fresh one", async () => {
    const maxAge = 20 * MINUTE;
    const log = new CountingLog();
    const { host, beat, options } = await setup(log, { sessionMaxAgeMs: maxAge });
    const guest = await host.openGuest();
    await host.submit(buy(guest, "QNTA", 2));
    await goIdle(host, beat, log);
    await beat(maxAge); // idle past the session's age

    // Sessions roll over only when a process starts; this one keeps going.
    expect(host.session.id).toBe(1);
    await host.stop(); // SIGTERM: the idle ticks are flushed to the old session
    const stoppedHash = host.exchange.stateHash();

    const old = await EngineHost.start({ ...options, sessionMaxAgeMs: Infinity, snapshotMs: 0 });
    expect(old.session.id).toBe(1);
    expect(old.exchange.stateHash()).toBe(stoppedHash);

    const fresh = await EngineHost.start(options);
    expect(fresh.session.id).not.toBe(1);
    expect(fresh.sequence).toBe(0);
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

  it("stops the host if another writer added to the session while it was idle", async () => {
    const { log } = await pgliteLog();
    const onFatal = vi.fn();
    const { host, beat } = await setup(log, { onFatal });
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
    expect(onFatal).toHaveBeenCalledOnce();
    expect(host.healthy).toBe(false);
    expect(host.sequence).toBe(seq); // and it wrote nothing
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
