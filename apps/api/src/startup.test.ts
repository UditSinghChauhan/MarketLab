/**
 * SIGTERM before the engine is ready, at each stage of startup (server.ts):
 * waiting for the writer lock, replaying the log with the lock held, and
 * building the app after replay. Each stage is held at a known point by a
 * barrier the test controls, not by timing.
 *
 * Needs TEST_DATABASE_URL (a role that may create databases); skipped without it.
 */

import { execFile } from "node:child_process";
import { constants, openSync, closeSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildServer,
  connectionsTo,
  createDatabase,
  describeExit,
  eventually,
  health,
  logState,
  startServer,
  testDatabaseUrl,
  writerLockHolders,
  type Exit,
  type ServerProcess,
  type TestDatabase,
} from "./test/process.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A signal before readiness must end the process within this long. */
const EXIT_BUDGET_MS = 2_000;

const exitWithin = (server: ServerProcess, ms: number): Promise<Exit> =>
  Promise.race([
    server.exited,
    sleep(ms).then(() => {
      throw new Error(`still running after ${String(ms)} ms:\n${server.output()}`);
    }),
  ]);

/** Status of a request, or 0 if the connection was refused or reset. */
async function statusOf(url: string, init?: RequestInit): Promise<number> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

describe.skipIf(!testDatabaseUrl)("SIGTERM before the engine is ready", () => {
  const admin = testDatabaseUrl ?? "";
  let db: TestDatabase;
  const servers: ServerProcess[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    await buildServer("startup");
  }, 60_000);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const server of servers.splice(0)) {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill("SIGKILL");
        await server.exited;
      }
    }
    await db.drop();
  });

  async function start(env: Record<string, string> = {}, ready = true) {
    const server = await startServer({ databaseUrl: db.url, env, ready });
    servers.push(server);
    return server;
  }

  /** A session with entries and a clean stop: what a deploy or restart starts from. */
  async function existingLog() {
    const first = await start();
    first.signal("SIGTERM");
    expect((await exitWithin(first, 10_000)).code).toBe(0);
    return logState(db.url);
  }

  /** After a stage's process has gone: the lock is free and a new process starts normally. */
  async function expectCleanAfterwards(head: number) {
    await eventually(async () => (await writerLockHolders(db.url)) === 0, 5_000, "lock release");
    await eventually(
      async () => (await connectionsTo(admin, db.name)) === 0,
      5_000,
      "its connection to close",
    );
    expect((await logState(db.url)).head).toBe(head); // nothing written after the signal

    const after = await start();
    expect(Number((await after.waitFor("lock_acquired")).waitedMs)).toBeLessThan(1_000);
    expect(await after.waitFor("replay_verified")).toMatchObject({ seq: head });
    expect((await health(after.base)).status).toBe(200);
    after.signal("SIGTERM");
    expect((await exitWithin(after, 10_000)).code).toBe(0);
  }

  it("while waiting for the writer lock: exits at once, holding nothing", async () => {
    db = await createDatabase(admin);
    const { head } = await existingLog();
    const old = await start();
    const waiting = await start({}, false);
    await waiting.waitFor("lock_waiting");
    expect(await health(waiting.base)).toMatchObject({
      status: 503,
      body: { status: "starting", reason: "waiting for the previous instance" },
    });

    const sent = waiting.signal("SIGTERM");
    const exit = await exitWithin(waiting, 10_000);
    expect(exit.code, describeExit(exit, waiting.output())).toBe(0);
    expect(exit.at - sent).toBeLessThan(EXIT_BUDGET_MS);
    expect(waiting.events.map((e) => e.event)).not.toContain("lock_acquired");
    expect(waiting.events.map((e) => e.event)).not.toContain("engine_ready");
    await eventually(
      async () => (await connectionsTo(admin, db.name)) === 1, // only the old instance's
      5_000,
      "the waiting process's connection to close",
    );

    const oldHead = (await logState(db.url)).head;
    old.signal("SIGTERM");
    expect((await exitWithin(old, 10_000)).code).toBe(0);
    expect(oldHead).toBeGreaterThanOrEqual(head);
    await expectCleanAfterwards((await logState(db.url)).head);
  }, 60_000);

  it("with the lock held, while replaying: exits at once, writes nothing, and the lock is freed", async () => {
    db = await createDatabase(admin);
    const { head } = await existingLog();

    // Replay reads log_entries: hold the table so it waits there, lock held.
    const barrier = new pg.Client({ connectionString: db.url });
    await barrier.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await barrier.query("COMMIT");
      await barrier.end();
    };
    cleanups.push(release);
    await barrier.query("BEGIN");
    await barrier.query("LOCK TABLE log_entries IN ACCESS EXCLUSIVE MODE");

    const replaying = await start({}, false);
    await replaying.waitFor("lock_acquired");
    await eventually(
      async () => {
        const { rows } = await barrier.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
          [db.name],
        );
        return (rows[0]?.n ?? 0) > 0;
      },
      5_000,
      "replay to wait on the log table",
    );
    expect(await writerLockHolders(db.url)).toBe(1);
    // Not serving: health says why, everything else is refused.
    expect(await health(replaying.base)).toMatchObject({
      status: 503,
      body: { status: "starting", reason: "replaying the command log" },
    });
    expect(await statusOf(`${replaying.base}/api/markets`)).toBe(503);
    expect(await statusOf(`${replaying.base}/api/session`, { method: "POST" })).toBe(503);

    const sent = replaying.signal("SIGTERM");
    const exit = await exitWithin(replaying, 10_000);
    expect(exit.code, describeExit(exit, replaying.output())).toBe(0);
    expect(exit.at - sent).toBeLessThan(EXIT_BUDGET_MS);
    expect(replaying.events.map((e) => e.event)).not.toContain("replay_verified");
    expect(replaying.events.map((e) => e.event)).not.toContain("engine_ready");
    expect(replaying.events.find((e) => e.event === "shutdown_completed")).toMatchObject({
      finalFlush: "not started",
      exitCode: 0,
    });

    // PostgreSQL notices the closed connection only when the waiting query
    // finishes; until then its backend keeps the writer lock. Measured, not assumed:
    await sleep(500);
    const heldWhileBlocked = await writerLockHolders(db.url);
    console.info(
      `writer lock holders 500 ms after exit, query still blocked: ${String(heldWhileBlocked)}`,
    );

    const releasedAt = performance.now();
    await release();
    await eventually(async () => (await writerLockHolders(db.url)) === 0, 5_000, "lock release");
    console.info(
      `writer lock freed ${(performance.now() - releasedAt).toFixed(0)} ms after the blocked query could finish`,
    );
    await expectCleanAfterwards(head);
  }, 60_000);

  it("after replay, while the app is being built: exits cleanly, never serving before readiness", async () => {
    db = await createDatabase(admin);
    const { head } = await existingLog();

    // The app reads WEB_DIST/index.html after replay. As a FIFO, that read
    // blocks until the test writes it, and the test's open for writing
    // returns exactly when the server has opened it: a known point in startup.
    const web = await mkdtemp(path.join(tmpdir(), "marketlab-web-"));
    const fifo = path.join(web, "index.html");
    await promisify(execFile)("mkfifo", [fifo]);
    let writerOpened = false;
    cleanups.push(async () => {
      // If the server never opened the FIFO, unblock our pending open for writing.
      if (!writerOpened) closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
      await rm(web, { recursive: true, force: true });
    });

    const building = await start({ WEB_DIST: web }, false);
    const writer = await Promise.race([
      open(fifo, "w"),
      sleep(15_000).then(() => {
        throw new Error(`the server never read index.html:\n${building.output()}`);
      }),
    ]);
    writerOpened = true;
    // The server is inside the app's construction: lock held, replay done.
    expect(building.events.map((e) => e.event)).toContain("replay_verified");
    expect(building.events.map((e) => e.event)).not.toContain("engine_ready");
    expect(await writerLockHolders(db.url)).toBe(1);

    const sent = building.signal("SIGTERM");
    // Meanwhile, a request arrives; it must not be served by the app.
    const request = statusOf(`${building.base}/api/markets`);
    await writer.writeFile(
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    );
    await writer.close();

    const exit = await exitWithin(building, 10_000);
    expect(exit.code, describeExit(exit, building.output())).toBe(0);
    expect(exit.at - sent).toBeLessThan(EXIT_BUDGET_MS);
    const completed = building.events.find((e) => e.event === "shutdown_completed");
    const readied = building.events.some((e) => e.event === "engine_ready");
    console.info(
      `signal during app construction: ${readied ? "became ready, then shut down gracefully" : "stopped before readiness"}; finalFlush=${String(completed?.finalFlush)}`,
    );
    // Node handles a signal between event-loop turns. Once the FIFO is read,
    // building the app runs to readiness without waiting on I/O, so in
    // practice the signal takes effect just after engine_ready, through the
    // full graceful shutdown. Either order is safe; check whichever happened.
    const status = await request;
    const names = building.events.map((e) => e.event);
    expect(names).not.toContain("persistence_failed");
    if (readied) {
      expect(names.indexOf("shutdown_started")).toBeGreaterThan(names.indexOf("engine_ready"));
      expect(completed).toMatchObject({ finalFlush: "saved", exitCode: 0 });
    } else {
      expect(completed).toMatchObject({ finalFlush: "not started", exitCode: 0 });
      expect([0, 503]).toContain(status); // nothing served before readiness
    }
    await expectCleanAfterwards(head);
  }, 60_000);
});
