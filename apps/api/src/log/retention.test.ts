/**
 * Retention parity: the memory and PostgreSQL logs keep the active session
 * (the latest by id) and prune exactly the sessions that started more than
 * seven days before `now`, to the millisecond. PostgreSQL runs in UTC and in
 * a time zone with daylight saving, on PGlite and, given TEST_DATABASE_URL,
 * on a real server.
 */

import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createDatabase, testDatabaseUrl } from "../test/process.js";
import { MemoryLog } from "./memory.js";
import { PostgresLog, type Queryable } from "./postgres.js";
import { RETENTION_DAYS, type CommandLog, type LogEntry } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = RETENTION_DAYS * DAY;
/** The seven days before T cross the end of US daylight saving (1 November 2026). */
const T = Date.UTC(2026, 10, 5, 12);
const entry: LogEntry = { kind: "ticks", count: 1, from: 0, at: 0 };

interface Subject {
  readonly log: CommandLog;
  /** Raw SQL on the log's own connection (PostgreSQL only). */
  readonly sql?: Queryable;
  /** Opens the log again on the same database, as a restart does (PostgreSQL only). */
  readonly reopen?: () => Promise<CommandLog>;
  readonly done: () => Promise<void>;
}

async function pglite(timeZone?: string): Promise<Subject> {
  const db = new PGlite();
  if (timeZone) await db.query(`SET TimeZone = '${timeZone}'`);
  return {
    log: await PostgresLog.open(db),
    sql: db,
    reopen: () => PostgresLog.open(db), // one connection: it already holds the lock
    done: () => db.close(),
  };
}

async function postgres(timeZone?: string): Promise<Subject> {
  const database = await createDatabase(testDatabaseUrl ?? "");
  const connect = async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    if (timeZone) await client.query(`SET TimeZone = '${timeZone}'`);
    return client;
  };
  let client = await connect();
  const first = client;
  let current = await PostgresLog.open(first, () => first.end());
  return {
    log: current,
    sql: { query: (text, params) => client.query(text, params) },
    reopen: async () => {
      await current.close(); // a restart: the old process's connection is gone
      const next = await connect();
      client = next;
      current = await PostgresLog.open(next, () => next.end());
      return current;
    },
    done: async () => {
      await current.close();
      await database.drop();
    },
  };
}

const subjects: [string, () => Promise<Subject>][] = [
  [
    "memory",
    () => {
      const log = new MemoryLog();
      return Promise.resolve({ log, done: () => Promise.resolve() });
    },
  ],
  ["postgres (PGlite, UTC)", () => pglite()],
  ["postgres (PGlite, America/New_York)", () => pglite("America/New_York")],
  ...(testDatabaseUrl
    ? ([
        ["postgres 16 (UTC)", () => postgres("UTC")],
        ["postgres 16 (America/New_York)", () => postgres("America/New_York")],
      ] as [string, () => Promise<Subject>][])
    : []),
];

/**
 * Creates one session per start time, in this order, each with one entry and
 * a snapshot. Starts need not increase (a clock can step back), so every call
 * must create a session: no age is below -Infinity.
 */
async function sessionsStartingAt(log: CommandLog, starts: readonly number[]) {
  const ids: number[] = [];
  for (const [i, start] of starts.entries()) {
    const session = await log.openSession(start, -Infinity, i + 1);
    await log.append(session.id, 1, entry);
    await log.saveSnapshot(session.id, { seq: 1, stateHash: "0".repeat(16), state: "{}" });
    ids.push(session.id);
  }
  return ids;
}

/** The ids still in the log, judged by their entries, and checked against their snapshots. */
async function survivors(log: CommandLog, ids: readonly number[]) {
  const kept: number[] = [];
  for (const id of ids) {
    const hasEntries = (await log.readEntries(id, 0, 1)).length > 0;
    expect(await log.loadSnapshot(id), `snapshot of session ${String(id)}`).toEqual(
      hasEntries ? expect.anything() : null,
    );
    if (hasEntries) kept.push(id);
  }
  return kept;
}

describe.each(subjects)("retention: %s", (_name, make) => {
  async function using(test: (subject: Subject) => Promise<void>) {
    const subject = await make();
    try {
      await test(subject);
    } finally {
      await subject.done();
    }
  }

  it("prunes exactly the sessions that started more than seven days before, to the millisecond", () =>
    using(async ({ log }) => {
      const ids = await sessionsStartingAt(log, [
        T - 30 * DAY,
        T - RETENTION - 1, // one millisecond past retention: pruned
        T - RETENTION, // exactly seven days: kept
        T - RETENTION + 1,
        T - DAY,
        T, // the active session
      ]);
      await log.pruneSessions(T);
      expect(await survivors(log, ids)).toEqual(ids.slice(2));
    }));

  it("never prunes the active session, even when it is the oldest or past retention", () =>
    using(async ({ log }) => {
      // The latest session started earliest (the clock stepped back), and is
      // past retention; the earlier one is past retention too.
      const ids = await sessionsStartingAt(log, [T - 20 * DAY, T - 30 * DAY]);
      await log.pruneSessions(T);
      expect(await survivors(log, ids)).toEqual([ids[1]]);
      // It is still the session a (re)start resumes.
      expect((await log.openSession(T, Infinity, 99)).id).toBe(ids[1]);
    }));

  it("keeps a lone session past retention: it is the active one", () =>
    using(async ({ log }) => {
      const ids = await sessionsStartingAt(log, [T - 8 * DAY]);
      await log.pruneSessions(T);
      expect(await survivors(log, ids)).toEqual(ids);
    }));

  it("numbers new sessions above every pruned one", () =>
    using(async ({ log }) => {
      const ids = await sessionsStartingAt(log, [T - 30 * DAY, T - 20 * DAY, T - 10 * DAY]);
      await log.pruneSessions(T);
      expect(await survivors(log, ids)).toEqual([ids[2]]);
      const [next] = await sessionsStartingAt(log, [T]);
      expect(next).toBeGreaterThan(Math.max(...ids));
      expect(await survivors(log, [...ids, next ?? 0])).toEqual([ids[2], next]);
    }));
});

describe.each(subjects.filter(([name]) => name.startsWith("postgres")))(
  "retention with unusual session ids: %s",
  (_name, make) => {
    it("keeps the highest id as the active session, whatever the ids are", async () => {
      const { log, sql, done } = await make();
      try {
        const insert = (id: number, startedAt: number) =>
          sql?.query("INSERT INTO sessions (id, seed, started_at) VALUES ($1, 1, $2)", [
            id,
            new Date(startedAt),
          ]);
        await insert(0, T - 30 * DAY); // id zero, past retention
        await insert(7, T - DAY); // recent, with a gap below it
        await insert(5_000_000_000, T - 30 * DAY); // above 2^32, the latest, past retention
        await log.pruneSessions(T);
        const { rows } = (await sql?.query("SELECT id FROM sessions ORDER BY id")) ?? { rows: [] };
        expect(rows.map((r) => Number((r as { id: unknown }).id))).toEqual([7, 5_000_000_000]);
        expect((await log.openSession(T, Infinity, 99)).id).toBe(5_000_000_000);
      } finally {
        await done();
      }
    });

    it("pruning at startup keeps the active session too", async () => {
      const { sql, reopen, done } = await make();
      try {
        // Startup prunes against the current time. The active session is eight
        // days old: a SESSION_HOURS over a week, or a long outage.
        const now = Date.now();
        await sql?.query(
          "INSERT INTO sessions (id, seed, started_at) VALUES (1, 1, $1), (2, 1, $2)",
          [new Date(now - 30 * DAY), new Date(now - 8 * DAY)],
        );
        const log = await reopen?.();
        const { rows } = (await sql?.query("SELECT id FROM sessions ORDER BY id")) ?? { rows: [] };
        expect(rows.map((r) => Number((r as { id: unknown }).id))).toEqual([2]);
        expect((await log?.openSession(now, Infinity, 99))?.id).toBe(2);
      } finally {
        await done();
      }
    });
  },
);
