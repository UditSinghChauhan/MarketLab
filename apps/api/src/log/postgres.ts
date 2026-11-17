/**
 * PostgreSQL command log.
 *
 * - One dedicated connection, holding a session-level advisory lock, so only
 *   one engine process can ever write to the log. A second instance fails at
 *   startup instead of corrupting the log.
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

const LockRow = z.object({ locked: z.boolean() });
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

export class PostgresLog implements CommandLog {
  readonly kind = "postgres";

  private constructor(
    private readonly db: Queryable,
    private readonly onClose: () => Promise<void>,
  ) {}

  /** Migrates the schema and takes the single-writer lock. */
  static async open(db: Queryable, onClose: () => Promise<void> = () => Promise.resolve()) {
    const [lock] = await select(db, LockRow, "SELECT pg_try_advisory_lock($1) AS locked", [
      WRITER_LOCK,
    ]);
    if (!lock?.locked) {
      throw new Error("Another engine process holds the command-log lock");
    }
    for (const statement of MIGRATION) await db.query(statement);
    await db.query(`DELETE FROM sessions WHERE started_at < now() - make_interval(days => $1)`, [
      RETENTION_DAYS,
    ]);
    return new PostgresLog(db, onClose);
  }

  async openSession(now: number, maxAgeMs: number, newSeed: number): Promise<Session> {
    const [latest] = await select(
      this.db,
      SessionRow,
      "SELECT id, seed, started_at FROM sessions ORDER BY id DESC LIMIT 1",
    );
    if (latest && now - latest.started_at.getTime() < maxAgeMs) {
      const rows = await select(
        this.db,
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
      this.db,
      IdRow,
      "INSERT INTO sessions (seed, started_at) VALUES ($1, $2) RETURNING id",
      [newSeed, new Date(now)],
    );
    if (!created) throw new Error("Could not create a session");
    return { id: created.id, seed: newSeed, startedAt: now, entries: [] };
  }

  async append(sessionId: number, seq: number, entry: LogEntry): Promise<void> {
    await this.db.query("INSERT INTO log_entries (session_id, seq, entry) VALUES ($1, $2, $3)", [
      sessionId,
      seq,
      JSON.stringify(entry),
    ]);
  }

  async readEntries(sessionId: number, after: number, limit: number): Promise<LogEntry[]> {
    const rows = await select(
      this.db,
      EntryRow,
      "SELECT entry FROM log_entries WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
      [sessionId, after, limit],
    );
    return rows.map((r) => parseEntry(r.entry));
  }

  async loadSnapshot(sessionId: number): Promise<StoredSnapshot | null> {
    const [row] = await select(
      this.db,
      SnapshotRow,
      "SELECT seq, state_hash, state FROM snapshots WHERE session_id = $1",
      [sessionId],
    );
    return row ? { seq: row.seq, stateHash: row.state_hash, state: row.state } : null;
  }

  async saveSnapshot(sessionId: number, snapshot: StoredSnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO snapshots (session_id, seq, state_hash, state) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id) DO UPDATE
         SET seq = EXCLUDED.seq, state_hash = EXCLUDED.state_hash,
             state = EXCLUDED.state, created_at = now()`,
      [sessionId, snapshot.seq, snapshot.stateHash, snapshot.state],
    );
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}
