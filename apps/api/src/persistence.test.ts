/**
 * Persistence failures, on the built server as a real process against a real
 * PostgreSQL server: the cases the in-process tests (host.test.ts,
 * static.test.ts, log.test.ts) and the CI smoke test cannot reach, because
 * they need a real connection to die, a reply to be lost after a commit, or
 * two processes to race.
 *
 * Every case ends by checking the log's invariant: a snapshot is never ahead
 * of the log's head.
 *
 * Needs TEST_DATABASE_URL (a role that may create databases); skipped without it.
 */

import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildServer,
  connectionsTo,
  createDatabase,
  describeExit,
  eventually,
  holdLogTable,
  logState,
  loggedCommands,
  openGuest,
  placeOrder,
  startPgProxy,
  startServer,
  terminateConnections,
  testDatabaseUrl,
  withClient,
  writerLockHolders,
  type Exit,
  type PgProxy,
  type ServerProcess,
  type TestDatabase,
} from "./test/process.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the exit, or fails if the process is still running after `ms`. */
const exitWithin = (server: ServerProcess, ms = 10_000): Promise<Exit> =>
  Promise.race([
    server.exited,
    sleep(ms).then(() => {
      throw new Error(`still running after ${String(ms)} ms:\n${server.output()}`);
    }),
  ]);

/** The point a replay must reach: the log head and the state hash after it (GET /api/replay). */
async function replayHead(base: string): Promise<{ seq: number; stateHash: string }> {
  const res = await fetch(`${base}/api/replay`);
  expect(res.status).toBe(200);
  return (await res.json()) as { seq: number; stateHash: string };
}

/** The caller's orders, as the API reports them. */
async function ordersOf(base: string, token: string): Promise<{ qty: number }[]> {
  const res = await fetch(`${base}/api/orders`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { qty: number }[];
}

describe.skipIf(!testDatabaseUrl)("persistence failures on PostgreSQL", () => {
  const admin = testDatabaseUrl ?? "";
  let db: TestDatabase;
  let proxy: PgProxy | undefined;
  const servers: ServerProcess[] = [];

  beforeAll(async () => {
    await buildServer("persistence");
  }, 60_000);

  afterEach(async () => {
    for (const server of servers) {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill("SIGKILL");
        await server.exited;
      }
    }
    servers.length = 0;
    await proxy?.stop();
    proxy = undefined;
    await db.drop();
  });

  async function start(env: Record<string, string> = {}, databaseUrl = db.url, ready = true) {
    const server = await startServer({ databaseUrl, env, ready });
    servers.push(server);
    return server;
  }

  /** The log's invariant, checked after every failure: no snapshot ahead of the head. */
  async function expectSnapshotNotAhead() {
    const state = await logState(db.url);
    expect(state.snapshotSeq ?? 0).toBeLessThanOrEqual(state.head);
    return state;
  }

  /** The process failed as a lost log must make it: a fatal persistence error and exit code 1. */
  async function expectFatalExit(server: ServerProcess) {
    const exit = await exitWithin(server);
    expect(exit.code, describeExit(exit, server.output())).toBe(1);
    const failed = server.events.findIndex((e) => e.event === "persistence_failed");
    expect(server.events[failed]).toMatchObject({ fatal: true, level: 50 });
    // Nothing is stored after the failure: no snapshot of state the log may lack.
    expect(server.events.slice(failed).map((e) => e.event)).not.toContain("snapshot_saved");
    await eventually(
      async () => (await connectionsTo(admin, db.name)) === 0,
      5_000,
      "the failed server's connections to close",
    );
  }

  /** Restarts on the same database and returns the state its replay reached. */
  async function restart(env: Record<string, string> = {}) {
    const next = await start(env);
    const verified = await next.waitFor("replay_verified");
    return { next, verified };
  }

  async function stopCleanly(server: ServerProcess) {
    server.signal("SIGTERM");
    const exit = await exitWithin(server);
    expect(exit.code, describeExit(exit, server.output())).toBe(0);
  }

  it("a connection killed between writes is fatal; a restart reaches the log head's hash", async () => {
    db = await createDatabase(admin);
    const server = await start();
    const token = await openGuest(server.base);
    expect(await placeOrder(server.base, token, 3)).toBe(201);
    // Everything so far is logged: this is the state a restart must rebuild.
    const head = await replayHead(server.base);

    // The engine holds its connection open while active; the database ends it.
    expect(await terminateConnections(admin, db.name)).toBe(1);
    await expectFatalExit(server);

    const state = await expectSnapshotNotAhead();
    expect(state.head).toBe(head.seq);
    const { next, verified } = await restart();
    expect(verified).toMatchObject({ seq: head.seq, stateHash: head.stateHash });
    expect(await ordersOf(next.base, token)).toHaveLength(1);
    await stopCleanly(next);
  }, 60_000);

  it("a connection killed during an append: 503, the order is not applied, a restart reaches the head", async () => {
    db = await createDatabase(admin);
    // No market ticks: no tick entry is written before the order's own, so the
    // write that waits below is the order's.
    const server = await start({ TICK_MS: "600000" });
    const token = await openGuest(server.base);
    const head = await replayHead(server.base);

    // The order's write waits on the table; the connection dies under it.
    const table = await holdLogTable(db.url, db.name);
    const order = placeOrder(server.base, token, 7);
    await table.waiting();
    expect(await terminateConnections(admin, db.name, true)).toBe(1);
    const status = await order;
    await table.release();
    console.info(`order whose write lost its connection: ${String(status)}`);
    expect(status).toBe(503);
    await expectFatalExit(server);

    const state = await expectSnapshotNotAhead();
    expect(state.head).toBe(head.seq);
    expect(await loggedCommands(db.url)).toEqual([]);
    const { next, verified } = await restart({ TICK_MS: "600000" });
    expect(verified).toMatchObject({ seq: head.seq, stateHash: head.stateHash });
    expect(await ordersOf(next.base, token)).toEqual([]);
    await stopCleanly(next);
  }, 60_000);

  it("unknown outcome: a committed order whose reply is lost answers 503, yet exists after a restart; a retry with its clientOrderId is answered with it, one without duplicates it", async () => {
    db = await createDatabase(admin);
    proxy = await startPgProxy(db.url);
    const server = await start({}, proxy.url);
    const token = await openGuest(server.base);
    const clientOrderId = randomUUID();

    // The INSERT of this order's log entry commits; its reply never arrives.
    // The proxy withholds the whole reply and resolves only once that reply
    // shows the commit (INSERT 0 1, then ReadyForQuery, idle).
    const lost = proxy.loseReplyTo('"qty":77').then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const status = await placeOrder(server.base, token, 77, clientOrderId);
    expect(await lost).toEqual({ result: { commandTag: "INSERT 0 1" } });
    console.info(`order whose reply was lost: ${String(status)}`);
    expect(status).toBe(503);
    await expectFatalExit(server);

    // The client was told it failed, but the log has it...
    expect((await loggedCommands(db.url)).map((c) => c.qty)).toEqual([77]);
    await expectSnapshotNotAhead();
    // ...and so does the restarted exchange.
    const { next, verified } = await restart();
    expect(verified.seq).toBe((await logState(db.url)).head);
    expect((await ordersOf(next.base, token)).map((o) => o.qty)).toEqual([77]);

    // The retry with the same clientOrderId is recognised: the replay rebuilt
    // the remembered ids from the log. Nothing new is placed or logged.
    expect(await placeOrder(next.base, token, 77, clientOrderId)).toBe(200);
    expect((await ordersOf(next.base, token)).map((o) => o.qty)).toEqual([77]);
    expect((await loggedCommands(db.url)).map((c) => c.qty)).toEqual([77]);

    // Without one, nothing identifies the retry as the same order, so it is
    // placed again: the limitation remains for clients that send no id.
    expect(await placeOrder(next.base, token, 77)).toBe(201);
    expect((await ordersOf(next.base, token)).map((o) => o.qty)).toEqual([77, 77]);
    expect((await loggedCommands(db.url)).map((c) => c.qty)).toEqual([77, 77]);
    await stopCleanly(next);
    await expectSnapshotNotAhead();
  }, 60_000);

  it.each([
    ["unreadable state", "UPDATE snapshots SET state = '{not json'"],
    ["a hash that does not match", "UPDATE snapshots SET state_hash = repeat('0', 16)"],
    ["a sequence ahead of the log", "UPDATE snapshots SET seq = seq + 5"],
  ])(
    "a stored snapshot with %s is ignored: the restart replays the whole log",
    async (_name, corrupt) => {
      db = await createDatabase(admin);
      const first = await start();
      const token = await openGuest(first.base);
      expect(await placeOrder(first.base, token, 4)).toBe(201);
      await stopCleanly(first); // stores a final snapshot at the head
      const before = await logState(db.url);
      expect(before.snapshotSeq).toBe(before.head);

      await withClient(db.url, (c) => c.query(corrupt));
      const { next, verified } = await restart();
      expect(next.output()).toContain("Ignoring the snapshot");
      expect(verified).toMatchObject({
        snapshotSeq: 0,
        entries: before.head,
        seq: before.head,
        stateHash: before.snapshotHash,
      });
      expect(await ordersOf(next.base, token)).toHaveLength(1);
      await stopCleanly(next); // and replaces it with a good one
      const after = await expectSnapshotNotAhead();
      expect(after.snapshotSeq).toBe(after.head);
    },
    60_000,
  );

  it("two processes started at once: exactly one takes the lock and writes", async () => {
    db = await createDatabase(admin);
    // Both start together on an empty database; neither has created the tables.
    const env = { LOCK_WAIT_MS: "3000" };
    const both = await Promise.all([start(env, db.url, false), start(env, db.url, false)]);
    const winner = await Promise.any(both.map((s) => s.waitFor("engine_ready").then(() => s)));
    const loser = both.find((s) => s !== winner);
    if (!loser) throw new Error("unreachable");
    console.info(`winner: process ${String(both.indexOf(winner))}`);

    const exit = await exitWithin(loser);
    expect(exit.code, describeExit(exit, loser.output())).toBe(1);
    expect(loser.events.map((e) => e.event)).not.toContain("lock_acquired");
    expect(loser.events.map((e) => e.event)).not.toContain("engine_ready");
    expect(loser.events.at(-1)).toMatchObject({ event: "lock_waiting", gaveUp: true });

    expect(winner.events.filter((e) => e.event === "lock_acquired")).toHaveLength(1);
    expect(await writerLockHolders(db.url)).toBe(1);
    expect((await logState(db.url)).sessions).toBe(1);
    expect(await connectionsTo(admin, db.name)).toBe(1); // the winner's own
    const token = await openGuest(winner.base);
    expect(await placeOrder(winner.base, token, 2)).toBe(201);
    await stopCleanly(winner);
    const state = await expectSnapshotNotAhead();
    expect(state.snapshotSeq).toBe(state.head);
    expect(state.sessions).toBe(1);
  }, 60_000);

  it("waking while PostgreSQL is unreachable is fatal, and leaves the log as it was", async () => {
    db = await createDatabase(admin);
    proxy = await startPgProxy(db.url);
    const server = await start({ IDLE_AFTER_MS: "1500" }, proxy.url);
    const token = await openGuest(server.base);
    // Idle: the log is suspended and holds no connection.
    await eventually(
      () =>
        Promise.resolve(
          server.events
            .filter((e) => e.event === "log_suspended" || e.event === "log_resumed")
            .at(-1)?.event === "log_suspended",
        ),
      10_000,
      "the log to suspend",
    );
    const before = await logState(db.url);
    expect(before.snapshotSeq).toBe(before.head); // stored on going idle

    await proxy.stop();
    const asked = performance.now();
    const status = await placeOrder(server.base, token, 5);
    console.info(
      `order on waking with the database unreachable: ${String(status)} in ${(performance.now() - asked).toFixed(0)} ms`,
    );
    expect(status).toBe(503);
    await expectFatalExit(server);
    expect(server.events.map((e) => e.event)).not.toContain("log_resumed");

    // No partial state: no entry, no snapshot, no session was written.
    expect(await expectSnapshotNotAhead()).toEqual(before);
    const { next, verified } = await restart();
    expect(verified).toMatchObject({ seq: before.head, stateHash: before.snapshotHash });
    expect(await ordersOf(next.base, token)).toEqual([]);
    await stopCleanly(next);
  }, 60_000);
});
