/**
 * Graceful shutdown, tested on the built server as a real process against a
 * real PostgreSQL server: SIGTERM must end the process quickly in every
 * state a deploy or restart can find it in, with the log complete and a final
 * snapshot at its head.
 *
 * Needs TEST_DATABASE_URL (a role that may create databases); skipped without it.
 */

import { Agent, request } from "node:http";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import pg from "pg";

import {
  WRITER_LOCK,
  buildServer,
  connectionsTo,
  createDatabase,
  eventually,
  holdLogTable,
  logState,
  loggedCommands,
  openGuest,
  placeOrder,
  startServer,
  describeExit,
  testDatabaseUrl,
  type ServerProcess,
  type TestDatabase,
} from "./test/process.js";

/** Longest a SIGTERM may take to end the process. */
const SHUTDOWN_BUDGET_MS = 5_000;
/** How long a test waits for the exit before calling it a hang. */
const WAIT_MS = Number(process.env.SHUTDOWN_TEST_WAIT_MS ?? 10_000);
const TEST_MS = WAIT_MS + 20_000;
/** Long enough for a few 100 ms market ticks to be waiting to be logged. */
const TICKS_PENDING_MS = 350;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!testDatabaseUrl)("graceful shutdown of the built server", () => {
  const admin = testDatabaseUrl ?? "";
  let db: TestDatabase;
  let server: ServerProcess | undefined;

  beforeAll(async () => {
    await buildServer("shutdown");
  }, 60_000);

  afterEach(async () => {
    if (server && server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
      await server.exited;
    }
    server = undefined;
    await db.drop();
  });

  async function start(env: Record<string, string> = {}) {
    db = await createDatabase(admin);
    server = await startServer({ databaseUrl: db.url, env });
    return server;
  }

  /** Waits for the exit and checks what every shutdown must leave behind. */
  async function expectCleanExit(running: ServerProcess, sentAt: number, code = 0) {
    const exit = await Promise.race([
      running.exited,
      sleep(WAIT_MS).then(() => {
        throw new Error(`still running ${String(WAIT_MS)} ms after SIGTERM`);
      }),
    ]);
    const elapsed = exit.at - sentAt;
    console.info(`exited ${String(exit.code)} after ${String(elapsed)} ms`);
    expect(exit.code, describeExit(exit, running.output())).toBe(code);
    expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS);

    const state = await logState(db.url);
    expect(state.snapshotSeq).toBe(state.head);
    await eventually(
      async () => (await connectionsTo(admin, db.name)) === 0,
      2_000,
      "the server's database connections to close",
    );
    return { elapsed, state };
  }

  it(
    "exits at once when idle",
    async () => {
      const running = await start();
      await expectCleanExit(running, running.signal("SIGTERM"));
      expect(running.events.map((e) => e.event)).not.toContain("persistence_failed");
    },
    TEST_MS,
  );

  it(
    "closes a keep-alive connection that is idle at the time",
    async () => {
      const running = await start();
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      const socketClosed = new Promise<void>((resolve, reject) => {
        const req = request(`${running.base}/api/markets`, { agent }, (res) => {
          res.resume();
          res.on("end", () => {
            req.socket?.once("close", () => {
              resolve();
            });
          });
        });
        req.on("error", reject);
        req.end();
      });
      await sleep(100); // the response is done and the socket sits idle in the agent
      const sentAt = running.signal("SIGTERM");
      await expectCleanExit(running, sentAt);
      await socketClosed;
      agent.destroy();
    },
    TEST_MS,
  );

  it(
    "ends an open event stream",
    async () => {
      const running = await start();
      const res = await fetch(`${running.base}/api/stream?symbol=ORBT`);
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // the hello message
      const sentAt = running.signal("SIGTERM");
      const ended = (async () => {
        for (;;) if ((await reader.read()).done) return;
      })();
      await expectCleanExit(running, sentAt);
      await ended;
    },
    TEST_MS,
  );

  /** Resolves once the server has taken the signal (or soon after, if it never says so). */
  const signalTaken = (running: ServerProcess) =>
    Promise.race([running.waitFor("shutdown_started", 2_000), sleep(300)]).catch(() => undefined);

  it(
    "refuses an event stream that connects while shutdown is writing",
    async () => {
      const running = await start();
      await sleep(TICKS_PENDING_MS); // the market ticks, so the final flush has something to write
      // The final flush waits on the log table, as on a slow database: the
      // window in which a new stream used to be accepted and never closed.
      const table = await holdLogTable(db.url, db.name);
      const sentAt = running.signal("SIGTERM");
      await signalTaken(running);
      await table.waiting();
      const res = await fetch(`${running.base}/api/stream?symbol=ORBT`);
      console.info(`stream after SIGTERM: ${String(res.status)}`);
      await table.release();
      await expectCleanExit(running, sentAt); // an accepted stream that is never closed hangs here
      expect(res.status).toBe(503);
    },
    TEST_MS,
  );

  it(
    "logs an order in flight at SIGTERM, refuses later ones, and still exits at once",
    async () => {
      const running = await start();
      const token = await openGuest(running.base);
      // The order's INSERT waits on the table: in flight when the signal arrives.
      const table = await holdLogTable(db.url, db.name);
      const first = placeOrder(running.base, token, 7);
      await table.waiting();
      const sentAt = running.signal("SIGTERM");
      await signalTaken(running);
      // Not awaited before the release: a server that queued it behind the
      // first order would otherwise wait on this test forever.
      const second = placeOrder(running.base, token, 9);
      await sleep(300);
      await table.release();
      const statuses = { first: await first, second: await second };
      console.info(
        `in flight: ${String(statuses.first)}, after SIGTERM: ${String(statuses.second)}`,
      );

      await expectCleanExit(running, sentAt);
      expect(statuses).toEqual({ first: 201, second: 503 });
      const qtys = (await loggedCommands(db.url)).map((c) => c.qty);
      expect(qtys).toContain(7);
      expect(qtys).not.toContain(9);
    },
    TEST_MS,
  );

  it(
    "gives up at SHUTDOWN_DEADLINE_MS with exit code 1, naming the step that hung",
    async () => {
      const running = await start({ SHUTDOWN_DEADLINE_MS: "1500" });
      await sleep(TICKS_PENDING_MS);
      // The final flush can never finish: the log table stays locked.
      const table = await holdLogTable(db.url, db.name);
      try {
        const sentAt = running.signal("SIGTERM");
        const exit = await Promise.race([
          running.exited,
          sleep(WAIT_MS).then(() => {
            throw new Error("still running");
          }),
        ]);
        expect(exit.code, describeExit(exit, running.output())).toBe(1);
        expect(exit.at - sentAt).toBeGreaterThanOrEqual(1_400);
        expect(exit.at - sentAt).toBeLessThan(SHUTDOWN_BUDGET_MS);
        expect(running.events.find((e) => e.event === "shutdown_deadline_exceeded")).toMatchObject({
          phase: "final flush and snapshot",
          deadlineMs: 1500,
          level: 50,
        });
        expect(running.events.map((e) => e.event)).not.toContain("shutdown_completed");
      } finally {
        await table.release();
      }
    },
    TEST_MS,
  );

  it(
    "resumes a suspended log to write the idle ticks and a final snapshot",
    async () => {
      const running = await start({ IDLE_AFTER_MS: "1500" });
      const suspended = await running.waitFor("log_suspended", 10_000);
      await sleep(TICKS_PENDING_MS); // idle ticks, held only in memory
      await expectCleanExit(running, running.signal("SIGTERM"));

      const after = running.events.slice(running.events.indexOf(suspended));
      expect(after.map((e) => e.event)).toEqual(
        expect.arrayContaining(["log_resumed", "snapshot_saved", "shutdown_completed"]),
      );
      expect(after.find((e) => e.event === "shutdown_completed")).toMatchObject({
        finalFlush: "saved",
        exitCode: 0,
      });
      expect((await logState(db.url)).head).toBeGreaterThan(Number(suspended.seq));
    },
    TEST_MS,
  );

  it(
    "exits cleanly, writing nothing, if another instance took the lock while the log was suspended",
    async () => {
      const running = await start({ IDLE_AFTER_MS: "1500" });
      const suspended = await running.waitFor("log_suspended", 10_000);
      await sleep(TICKS_PENDING_MS);
      // A new instance (as in a deploy) takes the writer lock while this one is idle.
      const other = new pg.Client({ connectionString: db.url });
      await other.connect();
      try {
        const { rows } = await other.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [WRITER_LOCK],
        );
        expect(rows[0]?.locked).toBe(true);
        const before = await logState(db.url);

        const sentAt = running.signal("SIGTERM");
        const exit = await Promise.race([
          running.exited,
          sleep(WAIT_MS).then(() => {
            throw new Error("still running");
          }),
        ]);
        expect(exit.code, describeExit(exit, running.output())).toBe(0);
        expect(exit.at - sentAt).toBeLessThan(SHUTDOWN_BUDGET_MS);
        expect(running.events.map((e) => e.event)).not.toContain("persistence_failed");
        expect(running.events.find((e) => e.event === "shutdown_completed")).toMatchObject({
          finalFlush: "owned-elsewhere",
          msg: "another instance owns the log; idle ticks not persisted (ADR 0007)",
          level: 40,
        });
        // Nothing written; the snapshot from going idle is still at the head.
        const after = await logState(db.url);
        expect(after).toEqual(before);
        expect(after.snapshotSeq).toBe(after.head);
        expect(after.head).toBe(Number(suspended.seq));
      } finally {
        await other.end();
      }
      await eventually(
        async () => (await connectionsTo(admin, db.name)) === 0,
        2_000,
        "the server's database connections to close",
      );
    },
    TEST_MS,
  );
});
