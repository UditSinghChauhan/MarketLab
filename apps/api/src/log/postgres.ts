/**
 * PostgreSQL command log.
 *
 * - One dedicated connection, holding a session-level advisory lock, so only
 *   one engine process can ever write to the log. A second instance fails at
 *   startup instead of corrupting the log.
 * - While nobody uses the exchange, the host suspends the log: the lock is
 *   released and the connection closed, so the database can scale to zero.
 *   The next use reconnects, retakes the lock without waiting, and `resume`
 *   checks that nobody wrote to the session meanwhile
 *   (docs/adr/0007-idle-aware-persistence.md).
 * - (session_id, seq) is the primary key: the engine assigns gap-free sequence
 *   numbers, so a duplicate or out-of-order write is rejected by the database.
 * - Sessions older than seven days are pruned at startup.
 * - Each session keeps at most one engine snapshot, so startup replays only the
 *   entries written after it (docs/adr/0006-startup-budget-and-snapshots.md).
 */

import { z } from "zod";

import {
  parseEntry,
  type CommandLog,
  type LogEntry,
  type Session,
  type StoredSnapshot,
} from "./types.js";

/** The subset of `pg.Client` (and PGlite) this module uses. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Opens and closes the log's database connection. The log connects again
 * after it has been suspended, so a connection may be opened many times.
 */
export interface Connector<C extends Queryable> {
  connect(): Promise<C>;
  disconnect(connection: C): Promise<void>;
}

const LockRow = z.object({ locked: z.boolean() });
const HeadRow = z.object({ head: z.coerce.number() });
const SessionRow = z.object({
  id: z.coerce.number(),
  seed: z.number(),
  started_at: z.coerce.date(),
});
const IdRow = z.object({ id: z.coerce.number() });
const EntryRow = z.object({ entry: z.unknown() });
const SnapshotRow = z.object({ seq: z.number(), state_hash: z.string(), state: z.string() });

/** Runs a query and validates each row, so driver differences fail loudly. */
async function select<T>(db: Queryable, schema: z.ZodType<T>, text: string, params?: unknown[]) {
  const { rows } = await db.query(text, params);
  return rows.map((row) => schema.parse(row));
}

const WRITER_LOCK = 0x6d6c6162; // "mlab"
const RETENTION_DAYS = 7;

const MIGRATION = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id          BIGSERIAL PRIMARY KEY,
     seed        INTEGER     NOT NULL,
     started_at  TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS log_entries (
     session_id  BIGINT      NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     seq         INTEGER     NOT NULL CHECK (seq > 0),
     entry       JSONB       NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (session_id, seq)
   )`,
  // TEXT, not JSONB: the state is read back whole and never queried.
  `CREATE TABLE IF NOT EXISTS snapshots (
     session_id  BIGINT      PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
     seq         INTEGER     NOT NULL CHECK (seq > 0),
     state_hash  TEXT        NOT NULL,
     state       TEXT        NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

/** Takes the single-writer lock without waiting; throws if another session holds it. */
async function takeWriterLock(db: Queryable): Promise<void> {
  const [lock] = await select(db, LockRow, "SELECT pg_try_advisory_lock($1) AS locked", [
    WRITER_LOCK,
  ]);
  if (!lock?.locked) throw new Error("Another engine process holds the command-log lock");
}

export class PostgresLog<C extends Queryable = Queryable> implements CommandLog {
  readonly kind = "postgres";
  /** True after a reconnect until `resume` has checked the log's head. */
  private headUnchecked = false;
  private connecting: Promise<C> | undefined;

  private constructor(
    private readonly connector: Connector<C>,
    /** The open connection, holding the writer lock; undefined while suspended. */
    private current: C | undefined,
    private readonly onClose: () => Promise<void>,
  ) {}

  /**
   * Opens the log on one connection it never closes itself (PGlite in tests).
   * Suspending only releases the writer lock.
   */
  static async open<D extends Queryable>(
    db: D,
    onClose: () => Promise<void> = () => Promise.resolve(),
  ): Promise<PostgresLog<D>> {
    return PostgresLog.start(
      { connect: () => Promise.resolve(db), disconnect: () => Promise.resolve() },
      onClose,
    );
  }

  /**
   * Opens the log through a connector: suspending releases the lock and
   * closes the connection, and the log connects again when it is next used.
   */
  static connect<D extends Queryable>(connector: Connector<D>): Promise<PostgresLog<D>> {
    return PostgresLog.start(connector, () => Promise.resolve());
  }

  /** Connects, takes the single-writer lock, migrates the schema and prunes old sessions. */
  private static async start<D extends Queryable>(
    connector: Connector<D>,
    onClose: () => Promise<void>,
  ): Promise<PostgresLog<D>> {
    const db = await connector.connect();
    try {
      await takeWriterLock(db);
      for (const statement of MIGRATION) await db.query(statement);
      await db.query(`DELETE FROM sessions WHERE started_at < now() - make_interval(days => $1)`, [
        RETENTION_DAYS,
      ]);
    } catch (error) {
      await connector.disconnect(db);
      throw error;
    }
    return new PostgresLog(connector, db, onClose);
  }

  get connected(): boolean {
    return this.current !== undefined;
  }

  /**
   * Releases the writer lock and closes the connection, so an idle database
   * can scale to zero without the connection being cut under the engine.
   */
  async suspend(): Promise<void> {
    const db = this.current;
    if (!db) return;
    this.current = undefined;
    try {
      await db.query("SELECT pg_advisory_unlock($1)", [WRITER_LOCK]);
    } finally {
      await this.connector.disconnect(db);
    }
  }

  /**
   * Reconnects and retakes the writer lock if the log was suspended, then
   * checks that the session still ends at `expectedSeq`, so no other process
   * wrote to it in between. A no-op once connected and checked.
   */
  async resume(sessionId: number, expectedSeq: number): Promise<void> {
    if (this.current && !this.headUnchecked) return;
    const db = await this.db();
    const [row] = await select(
      db,
      HeadRow,
      "SELECT COALESCE(MAX(seq), 0) AS head FROM log_entries WHERE session_id = $1",
      [sessionId],
    );
    const head = row?.head ?? 0;
    if (head !== expectedSeq) {
      throw new Error(
        `The command log changed while the engine was away: expected ${String(expectedSeq)} entries, found ${String(head)}`,
      );
    }
    this.headUnchecked = false;
  }

  /**
   * The open connection, reconnecting (and retaking the lock) after a suspend.
   * Callers that arrive while a reconnect is under way share it: a second
   * connection would find the lock taken by the first.
   */
  private db(): Promise<C> {
    if (this.current) return Promise.resolve(this.current);
    this.connecting ??= this.reconnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async reconnect(): Promise<C> {
    const db = await this.connector.connect();
    try {
      await takeWriterLock(db); // fail fast: never wait behind another writer
    } catch (error) {
      await this.connector.disconnect(db);
      throw error;
    }
    this.current = db;
    this.headUnchecked = true;
    return db;
  }

  async openSession(now: number, maxAgeMs: number, newSeed: number): Promise<Session> {
    const db = await this.db();
    const [latest] = await select(
      db,
      SessionRow,
      "SELECT id, seed, started_at FROM sessions ORDER BY id DESC LIMIT 1",
    );
    if (latest && now - latest.started_at.getTime() < maxAgeMs) {
      const rows = await select(
        db,
        EntryRow,
        "SELECT entry FROM log_entries WHERE session_id = $1 ORDER BY seq",
        [latest.id],
      );
      return {
        id: latest.id,
        seed: latest.seed,
        startedAt: latest.started_at.getTime(),
        entries: rows.map((r) => parseEntry(r.entry)),
      };
    }
    const [created] = await select(
      db,
      IdRow,
      "INSERT INTO sessions (seed, started_at) VALUES ($1, $2) RETURNING id",
      [newSeed, new Date(now)],
    );
    if (!created) throw new Error("Could not create a session");
    return { id: created.id, seed: newSeed, startedAt: now, entries: [] };
  }

  async append(sessionId: number, seq: number, entry: LogEntry): Promise<void> {
    const db = await this.db();
    await db.query("INSERT INTO log_entries (session_id, seq, entry) VALUES ($1, $2, $3)", [
      sessionId,
      seq,
      JSON.stringify(entry),
    ]);
  }

  async readEntries(sessionId: number, after: number, limit: number): Promise<LogEntry[]> {
    const rows = await select(
      await this.db(),
      EntryRow,
      "SELECT entry FROM log_entries WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
      [sessionId, after, limit],
    );
    return rows.map((r) => parseEntry(r.entry));
  }

  async loadSnapshot(sessionId: number): Promise<StoredSnapshot | null> {
    const [row] = await select(
      await this.db(),
      SnapshotRow,
      "SELECT seq, state_hash, state FROM snapshots WHERE session_id = $1",
      [sessionId],
    );
    return row ? { seq: row.seq, stateHash: row.state_hash, state: row.state } : null;
  }

  async saveSnapshot(sessionId: number, snapshot: StoredSnapshot): Promise<void> {
    const db = await this.db();
    await db.query(
      `INSERT INTO snapshots (session_id, seq, state_hash, state) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id) DO UPDATE
         SET seq = EXCLUDED.seq, state_hash = EXCLUDED.state_hash,
             state = EXCLUDED.state, created_at = now()`,
      [sessionId, snapshot.seq, snapshot.stateHash, snapshot.state],
    );
  }

  async close(): Promise<void> {
    const db = this.current;
    this.current = undefined;
    if (db) await this.connector.disconnect(db);
    await this.onClose();
  }
}
