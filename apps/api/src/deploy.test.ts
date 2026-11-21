/**
 * Deploys with a single writer (docs/adr/0009-deploys-with-a-single-writer.md):
 * Render starts the new instance while the old one still runs. Two built
 * servers against one real PostgreSQL database play both parts.
 *
 * Needs TEST_DATABASE_URL (a role that may create databases); skipped without it.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildServer,
  connectionsTo,
  createDatabase,
  describeExit,
  eventually,
  health,
  logState,
  openGuest,
  placeOrder,
  startServer,
  testDatabaseUrl,
  type Exit,
  type ServerProcess,
  type TestDatabase,
} from "./test/process.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the exit, or fails if the process is still running after `ms`. */
const exitWithin = (server: ServerProcess, ms: number): Promise<Exit> =>
  Promise.race([
    server.exited,
    sleep(ms).then(() => {
      throw new Error(`still running after ${String(ms)} ms:\n${server.output()}`);
    }),
  ]);

const STARTING = { status: "starting", reason: "waiting for the previous instance" };

const count = (server: ServerProcess, event: string) =>
  server.events.filter((e) => e.event === event).length;

/** The `n`th (0-based) event of that name, waiting for it if need be. */
async function nth(server: ServerProcess, event: string, n: number, ms = 10_000) {
  await eventually(
    async () => Promise.resolve(count(server, event) > n),
    ms,
    `${event} #${String(n + 1)}`,
  );
  const found = server.events.filter((e) => e.event === event)[n];
  if (!found) throw new Error(`no ${event} #${String(n + 1)}`);
  return found;
}

describe.skipIf(!testDatabaseUrl)("a deploy: two instances, one command log", () => {
  const admin = testDatabaseUrl ?? "";
  let db: TestDatabase;
  const servers: ServerProcess[] = [];

  beforeAll(async () => {
    await buildServer("deploy");
  }, 60_000);

  afterEach(async () => {
    for (const server of servers) {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill("SIGKILL");
        await server.exited;
      }
    }
    servers.length = 0;
    await db.drop();
  });

  async function start(env: Record<string, string> = {}, ready = true) {
    const server = await startServer({ databaseUrl: db.url, env, ready });
    servers.push(server);
    return server;
  }

  /** The new instance: listening, but not ready until it holds the lock. */
  async function startWaiting(env: Record<string, string> = {}) {
    const server = await start(env, false);
    await server.waitFor("lock_waiting");
    return server;
  }

  it("waits while the old instance is in use, then takes over once it goes idle", async () => {
    db = await createDatabase(admin);
    const old = await start({ IDLE_AFTER_MS: "2000" });
    // Someone is on the site: a stream keeps the old instance active.
    const watching = new AbortController();
    const stream = await fetch(`${old.base}/api/stream?symbol=ORBT`, {
      signal: watching.signal,
    });
    expect(stream.status).toBe(200);
    // On a loaded machine the old instance may have gone idle before the
    // stream connected (or been suspending as it did); watched now, it wakes
    // and retakes the lock. Let a few 100 ms ticks settle that first.
    await sleep(500);
    const suspends = count(old, "log_suspended");
    if (suspends > count(old, "log_resumed")) await nth(old, "log_resumed", suspends - 1);

    // The new instance replays the whole log, with no snapshot to start from.
    const next = await startWaiting({ SNAPSHOT_MINUTES: "0" });
    await sleep(2_500); // longer than the old one's idle threshold
    expect(count(old, "log_suspended")).toBe(suspends); // watched: it stays active
    expect(await health(next.base)).toEqual({ status: 503, body: STARTING });
    const page = await fetch(`${next.base}/api/markets`);
    expect(page.status).toBe(503);
    expect((await health(old.base)).status).toBe(200);

    // The visitor leaves; the old instance goes idle and releases the lock.
    watching.abort();
    const suspended = await nth(old, "log_suspended", suspends);
    const ready = await next.waitFor("engine_ready", 10_000);
    const acquired = await next.waitFor("lock_acquired");
    const handover = Number(ready.time) - Number(suspended.time);
    console.info(
      `waited ${String(acquired.waitedMs)} ms for the lock; ready ${String(handover)} ms after the old instance suspended`,
    );
    expect(Number(acquired.waitedMs)).toBeGreaterThan(2_000);
    expect(handover).toBeLessThan(5_000); // one 2 s poll plus replay; about 2 s when unloaded

    const now = await health(next.base);
    expect(now.status).toBe(200);
    expect(now.body.status).toBe("ok");

    // It rebuilt exactly the state the old instance logged: the old one's
    // snapshot at going idle is at the head, and the new one replayed every
    // entry up to it and reached the same hash.
    const state = await logState(db.url);
    expect(state.snapshotSeq).toBe(state.head);
    const verified = await next.waitFor("replay_verified");
    expect(verified).toMatchObject({ seq: state.head, snapshotSeq: 0, entries: state.head });
    expect(verified.stateHash).toBe(state.snapshotHash);

    // Render stops the old instance; it no longer owns the log and writes nothing.
    const sent = old.signal("SIGTERM");
    const exit = await exitWithin(old, 10_000);
    expect(exit.code, describeExit(exit, old.output())).toBe(0);
    expect(exit.at - sent).toBeLessThan(5_000);
    expect(old.events.find((e) => e.event === "shutdown_completed")).toMatchObject({
      finalFlush: "owned-elsewhere",
    });
    expect((await logState(db.url)).head).toBe(state.head);
    expect((await health(next.base)).status).toBe(200);

    next.signal("SIGTERM");
    expect((await exitWithin(next, 10_000)).code).toBe(0);
  }, 60_000);

  it("gives up after LOCK_WAIT_MS, leaving the old instance serving untouched", async () => {
    db = await createDatabase(admin);
    const old = await start();
    const before = await logState(db.url);
    const token = await openGuest(old.base);

    const sent = Date.now();
    const next = await startWaiting({ LOCK_WAIT_MS: "3000" });
    expect(await health(next.base)).toEqual({ status: 503, body: STARTING });
    const exit = await exitWithin(next, 10_000);
    const waited = exit.at - sent;
    console.info(`the new instance gave up after ${String(waited)} ms`);
    expect(exit.code, describeExit(exit, next.output())).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(3_000);
    expect(waited).toBeLessThan(6_000);
    expect(next.events.map((e) => e.event)).not.toContain("lock_acquired");
    expect(next.events.at(-1)).toMatchObject({ event: "lock_waiting", gaveUp: true, level: 50 });

    // The old instance never noticed: same session, still serving and writing.
    expect((await logState(db.url)).sessions).toBe(1);
    expect((await logState(db.url)).session).toBe(before.session);
    expect((await health(old.base)).status).toBe(200);
    expect(await placeOrder(old.base, token, 3)).toBe(201);
    expect(old.events.map((e) => e.event)).not.toContain("persistence_failed");
    await eventually(
      async () => (await connectionsTo(admin, db.name)) === 1, // the old instance's own
      2_000,
      "the new instance's connection to close",
    );

    old.signal("SIGTERM");
    expect((await exitWithin(old, 10_000)).code).toBe(0);
  }, 60_000);

  it("after the takeover, the old instance answers 503 at once and still stops cleanly", async () => {
    db = await createDatabase(admin);
    const old = await start({ IDLE_AFTER_MS: "1500" });
    await old.waitFor("log_suspended", 10_000);

    // Nobody was on the old instance: the new one takes over at once.
    const next = await start();
    const acquired = await next.waitFor("lock_acquired");
    expect(Number(acquired.waitedMs)).toBeLessThan(1_000);
    expect((await health(next.base)).status).toBe(200);
    const before = await logState(db.url);

    // A request still routed to the old instance must not wait or write.
    const asked = performance.now();
    const res = await fetch(`${old.base}/api/session`, { method: "POST" });
    const took = performance.now() - asked;
    console.info(`the old instance refused in ${took.toFixed(0)} ms`);
    expect(res.status).toBe(503);
    expect(took).toBeLessThan(1_500);
    const oldHealth = await health(old.base);
    expect(oldHealth.status).toBe(503);
    expect(oldHealth.body).toMatchObject({
      status: "stopping",
      reason: "another instance owns the command log",
    });
    expect((await fetch(`${old.base}/api/markets`)).status).toBe(503);

    // No false fatal error: it waits for SIGTERM, then exits cleanly.
    await sleep(1_000);
    expect(old.child.exitCode).toBeNull();
    expect(old.events.filter((e) => e.event === "persistence_failed")).toEqual([
      expect.objectContaining({ fatal: false, level: 40 }),
    ]);
    const sent = old.signal("SIGTERM");
    const exit = await exitWithin(old, 10_000);
    expect(exit.code, describeExit(exit, old.output())).toBe(0);
    expect(exit.at - sent).toBeLessThan(5_000);
    expect(old.events.find((e) => e.event === "shutdown_completed")).toMatchObject({
      finalFlush: "owned-elsewhere",
      exitCode: 0,
    });

    expect((await logState(db.url)).head).toBe(before.head);
    expect((await health(next.base)).status).toBe(200);
    next.signal("SIGTERM");
    expect((await exitWithin(next, 10_000)).code).toBe(0);
  }, 60_000);

  it("ends a stream that is open on the old instance when it finds it was superseded", async () => {
    // A stream keeps the old instance active, so it cannot release the lock
    // while one is open (the first test). The reachable case is a visitor who
    // reaches the old instance after it released the lock and the new one took
    // it, while Render still routes there: that stream's own wake-up is what
    // finds the takeover, so the stream is open at that moment.
    db = await createDatabase(admin);
    const old = await start({ IDLE_AFTER_MS: "1500" });
    await old.waitFor("log_suspended", 10_000);
    const next = await start(); // takes the free lock at once
    expect((await health(next.base)).status).toBe(200);
    const before = await logState(db.url);

    const opened = performance.now();
    const res = await fetch(`${old.base}/api/stream?symbol=ORBT`);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"hello"'); // really open

    // Watched, the old instance wakes, tries to retake the lock, stands down,
    // and closes the stream from its side.
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return performance.now() - opened;
    })();
    const endedAfter = await Promise.race([
      ended,
      sleep(5_000).then(() => {
        throw new Error(`the stream stayed open:\n${old.output()}`);
      }),
    ]);
    console.info(`the old instance's stream ended ${endedAfter.toFixed(0)} ms after it opened`);
    expect(endedAfter).toBeLessThan(2_000);
    expect(await old.waitFor("persistence_failed")).toMatchObject({ fatal: false, level: 40 });
    expect(old.child.exitCode).toBeNull();

    // It refuses everything else, including a new stream; it wrote nothing.
    expect((await fetch(`${old.base}/api/stream?symbol=ORBT`)).status).toBe(503);
    expect((await fetch(`${old.base}/api/session`, { method: "POST" })).status).toBe(503);
    expect((await health(old.base)).body).toMatchObject({ status: "stopping" });
    expect((await logState(db.url)).head).toBe(before.head);
    expect((await health(next.base)).status).toBe(200);

    old.signal("SIGTERM");
    expect((await exitWithin(old, 10_000)).code).toBe(0);
    next.signal("SIGTERM");
    expect((await exitWithin(next, 10_000)).code).toBe(0);
  }, 60_000);

  it("stops at once if signalled while still waiting for the lock", async () => {
    db = await createDatabase(admin);
    const old = await start();
    const next = await startWaiting();
    const sent = next.signal("SIGTERM");
    const exit = await exitWithin(next, 10_000);
    expect(exit.code, describeExit(exit, next.output())).toBe(0);
    expect(exit.at - sent).toBeLessThan(2_000);
    expect(next.events.find((e) => e.event === "shutdown_completed")).toMatchObject({
      finalFlush: "not started",
    });
    expect((await health(old.base)).status).toBe(200);
    old.signal("SIGTERM");
    expect((await exitWithin(old, 10_000)).code).toBe(0);
  }, 60_000);
});
