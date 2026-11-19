import type { CommandLog, LogEntry, Session, StoredSnapshot } from "./types.js";

/**
 * In-memory log for local development and tests. Lost on restart. It has no
 * connection, but it keeps the same suspend and resume contract as the
 * Postgres log, including the head check, so tests can observe both.
 */
export class MemoryLog implements CommandLog {
  readonly kind = "memory";
  private sessions: { id: number; seed: number; startedAt: number; entries: LogEntry[] }[] = [];
  private suspended = false;

  get connected(): boolean {
    return !this.suspended;
  }

  suspend(): Promise<void> {
    this.suspended = true;
    return Promise.resolve();
  }

  resume(sessionId: number, expectedSeq: number): Promise<void> {
    this.suspended = false;
    const head = this.sessions.find((s) => s.id === sessionId)?.entries.length ?? 0;
    if (head !== expectedSeq) {
      return Promise.reject(
        new Error(
          `The command log changed: expected ${String(expectedSeq)} entries, found ${String(head)}`,
        ),
      );
    }
    return Promise.resolve();
  }

  openSession(now: number, maxAgeMs: number, newSeed: number): Promise<Session> {
    this.suspended = false;
    const latest = this.sessions.at(-1);
    if (latest && now - latest.startedAt < maxAgeMs) {
      return Promise.resolve({ ...latest, entries: [...latest.entries] });
    }
    const session = { id: this.sessions.length + 1, seed: newSeed, startedAt: now, entries: [] };
    this.sessions.push(session);
    return Promise.resolve({ ...session, entries: [] });
  }

  append(sessionId: number, seq: number, entry: LogEntry): Promise<void> {
    this.suspended = false;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.reject(new Error(`Unknown session ${String(sessionId)}`));
    if (seq !== session.entries.length + 1) {
      return Promise.reject(new Error(`Out-of-order append: ${String(seq)}`));
    }
    session.entries.push(structuredClone(entry));
    return Promise.resolve();
  }

  readEntries(sessionId: number, after: number, limit: number): Promise<LogEntry[]> {
    this.suspended = false;
    const session = this.sessions.find((s) => s.id === sessionId);
    return Promise.resolve(structuredClone(session?.entries.slice(after, after + limit) ?? []));
  }

  private readonly snapshots = new Map<number, StoredSnapshot>();

  loadSnapshot(sessionId: number): Promise<StoredSnapshot | null> {
    this.suspended = false;
    return Promise.resolve(this.snapshots.get(sessionId) ?? null);
  }

  saveSnapshot(sessionId: number, snapshot: StoredSnapshot): Promise<void> {
    this.suspended = false;
    this.snapshots.set(sessionId, snapshot);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
