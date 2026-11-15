import type { CommandLog, LogEntry, Session, StoredSnapshot } from "./types.js";

/** In-memory log for local development and tests. Lost on restart. */
export class MemoryLog implements CommandLog {
  readonly kind = "memory";
  private sessions: { id: number; seed: number; startedAt: number; entries: LogEntry[] }[] = [];

  openSession(now: number, maxAgeMs: number, newSeed: number): Promise<Session> {
    const latest = this.sessions.at(-1);
    if (latest && now - latest.startedAt < maxAgeMs) {
      return Promise.resolve({ ...latest, entries: [...latest.entries] });
    }
    const session = { id: this.sessions.length + 1, seed: newSeed, startedAt: now, entries: [] };
    this.sessions.push(session);
    return Promise.resolve({ ...session, entries: [] });
  }

  append(sessionId: number, seq: number, entry: LogEntry): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.reject(new Error(`Unknown session ${String(sessionId)}`));
    if (seq !== session.entries.length + 1) {
      return Promise.reject(new Error(`Out-of-order append: ${String(seq)}`));
    }
    session.entries.push(structuredClone(entry));
    return Promise.resolve();
  }

  private readonly snapshots = new Map<number, StoredSnapshot>();

  loadSnapshot(sessionId: number): Promise<StoredSnapshot | null> {
    return Promise.resolve(this.snapshots.get(sessionId) ?? null);
  }

  saveSnapshot(sessionId: number, snapshot: StoredSnapshot): Promise<void> {
    this.snapshots.set(sessionId, snapshot);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
