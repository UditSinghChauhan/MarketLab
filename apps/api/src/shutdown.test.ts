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

import {
  buildServer,
  connectionsTo,
  createDatabase,
  eventually,
  logState,
  startServer,
  testDatabaseUrl,
  type ServerProcess,
  type TestDatabase,
} from "./test/process.js";

/** Longest a SIGTERM may take to end the process. */
const SHUTDOWN_BUDGET_MS = 5_000;
/** How long a test waits for the exit before calling it a hang. */
const WAIT_MS = Number(process.env.SHUTDOWN_TEST_WAIT_MS ?? 10_000);
const TEST_MS = WAIT_MS + 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!testDatabaseUrl)("graceful shutdown of the built server", () => {
  const admin = testDatabaseUrl ?? "";
  let db: TestDatabase;
  let server: ServerProcess | undefined;

  beforeAll(async () => {
    await buildServer();
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
    expect(exit.code, running.output()).toBe(code);
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
});
