/**
 * Session rollover in a running server, on real PostgreSQL: an idle session
 * that has reached SESSION_HOURS is ended and replaced in place, without a
 * restart (apps/api/src/host.ts, `rollover`).
 *
 * The warm-up is production's in ticks: 5 minutes at TICK_MS=100 is the same
 * 3,000 ticks as 30 minutes at 600 ms, so `warmupMs` measures what a command
 * arriving during a production rollover would wait for.
 *
 * Needs TEST_DATABASE_URL (a role that may create databases); skipped without it.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildServer,
  createDatabase,
  describeExit,
  openGuest,
  placeOrder,
  startServer,
  testDatabaseUrl,
  withClient,
  type ServerProcess,
  type TestDatabase,
} from "./test/process.js";

const ROLLOVER_ENV = {
  SESSION_HOURS: String(8 / 3600), // eight seconds
  IDLE_AFTER_MS: "1000",
  WARMUP_MINUTES: "5",
};

/** Entry count and a digest of every entry of one session, to show it never changes. */
async function sessionLog(url: string, session: number) {
  return withClient(url, async (db) => {
    const { rows } = await db.query<{ entries: number; digest: string | null }>(
      `SELECT COUNT(*)::int AS entries, md5(string_agg(entry::text, ',' ORDER BY seq)) AS digest
         FROM log_entries WHERE session_id = $1`,
      [session],
    );
    return rows[0] ?? { entries: 0, digest: null };
  });
}

async function sessionIds(url: string): Promise<number[]> {
  return withClient(url, async (db) => {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM sessions ORDER BY id");
    return rows.map((r) => Number(r.id));
  });
}

async function snapshotOf(url: string, session: number) {
  return withClient(url, async (db) => {
    const { rows } = await db.query<{ seq: number; state_hash: string }>(
      "SELECT seq, state_hash FROM snapshots WHERE session_id = $1",
      [session],
    );
    return rows[0];
  });
}

describe.skipIf(!testDatabaseUrl)("session rollover on PostgreSQL", () => {
  const admin = testDatabaseUrl ?? "";
  let db: TestDatabase;
  const servers: ServerProcess[] = [];

  beforeAll(async () => {
    await buildServer("rollover");
  }, 60_000);

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill("SIGKILL");
        await server.exited;
      }
    }
    await db.drop();
  });

  async function start(env: Record<string, string>) {
    const server = await startServer({ databaseUrl: db.url, env });
    servers.push(server);
    return server;
  }

  it("replaces an idle session in place; a restart resumes the new one", async () => {
    db = await createDatabase(admin);
    const server = await start(ROLLOVER_ENV);
    const ready = await server.waitFor("replay_verified");
    const first = Number(ready.session);

    // A visitor trades and leaves; the server goes idle.
    const token = await openGuest(server.base);
    expect(await placeOrder(server.base, token, 3)).toBe(201);
    // A session from eight days ago, past retention.
    await withClient(db.url, (c) =>
      c.query(
        "INSERT INTO sessions (id, seed, started_at) VALUES (0, 1, now() - interval '8 days')",
      ),
    );

    const rolled = await server.waitFor("session_rolled_over", 30_000);
    console.info(
      `rollover: ${String(rolled.ms)} ms in all, of which the warm-up (${String(rolled.warmupTicks)} ticks) ${String(rolled.warmupMs)} ms`,
    );
    expect(rolled).toMatchObject({ from: first, session: first + 1, seq: 1, warmupTicks: 3_000 });
    const second = first + 1;

    // The old session: complete, with its order, and a final snapshot at its end.
    const old = await sessionLog(db.url, first);
    expect(old.entries).toBe(rolled.fromSeq);
    expect((await snapshotOf(db.url, first))?.seq).toBe(old.entries);
    // The new session: the warm-up (entry 1, per the event), snapshotted at once;
    // the idle server's next beat may already have logged one more tick and
    // suspended the log. The stale session is gone.
    expect((await sessionLog(db.url, second)).entries).toBeGreaterThanOrEqual(1);
    expect((await snapshotOf(db.url, second))?.seq).toBeGreaterThanOrEqual(1);
    expect(await sessionIds(db.url)).toEqual([first, second]);

    // The visitor's token belonged to the old session.
    const account = await fetch(`${server.base}/api/account`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(account.status).toBe(401);
    expect(await account.json()).toMatchObject({ error: { code: "session_expired" } });

    // Play the new session, stop, and restart: the new session is resumed.
    const fresh = await openGuest(server.base);
    expect(await placeOrder(server.base, fresh, 2)).toBe(201);
    server.signal("SIGTERM");
    const exit = await server.exited;
    expect(exit.code, describeExit(exit, server.output())).toBe(0);
    const final = await snapshotOf(db.url, second);

    const restarted = await start({ ...ROLLOVER_ENV, SESSION_HOURS: "24" });
    expect(await restarted.waitFor("replay_verified")).toMatchObject({
      session: second,
      seq: final?.seq,
      stateHash: final?.state_hash,
    });
    expect(await sessionLog(db.url, first)).toEqual(old); // never touched again
    restarted.signal("SIGTERM");
    expect((await restarted.exited).code).toBe(0);
  }, 90_000);
});
