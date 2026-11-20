/**
 * Lifecycle events: one JSON line per event, in the same shape as Fastify's
 * pino logs (`level`, `time`, `msg`), with a machine-readable `event` name, so
 * operators and process-level tests can follow the engine's lifecycle without
 * parsing prose.
 *
 * Fields are plain values. Tokens and client addresses must never be logged:
 * any field whose name suggests one is dropped before the line is written.
 */

export type LifecycleEvent =
  | "engine_ready"
  | "lock_acquired"
  | "lock_waiting"
  | "log_suspended"
  | "log_resumed"
  | "snapshot_saved"
  | "replay_verified"
  | "session_rolled_over"
  | "persistence_failed"
  | "shutdown_started"
  | "shutdown_completed"
  | "shutdown_deadline_exceeded";

export type EventFields = Readonly<Record<string, string | number | boolean | null>>;

export type EventLevel = "info" | "warn" | "error";

export interface EventNote {
  /** Human-readable text; the event name when absent. */
  readonly message?: string;
  /** Overrides the event's usual level. */
  readonly level?: EventLevel;
}

/** Emits one lifecycle event. */
export type EmitEvent = (event: LifecycleEvent, fields?: EventFields, note?: EventNote) => void;

const LEVELS: Record<EventLevel, number> = { info: 30, warn: 40, error: 50 };

const DEFAULT_LEVEL: Partial<Record<LifecycleEvent, EventLevel>> = {
  lock_waiting: "warn",
  persistence_failed: "error",
  shutdown_deadline_exceeded: "error",
};

/** Field names that could carry a secret or a client's address. */
const FORBIDDEN =
  /token|secret|password|authorization|cookie|forwarded|remote|address|^(client_?)?ip$/i;

/** Drops any field whose name suggests a token or a client address. */
export function safeFields(fields: EventFields = {}): EventFields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !FORBIDDEN.test(key)));
}

export function createEventLog(
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
  now: () => number = Date.now,
): EmitEvent {
  return (event, fields, note) => {
    const level = note?.level ?? DEFAULT_LEVEL[event] ?? "info";
    const line = {
      ...safeFields(fields),
      level: LEVELS[level],
      time: now(),
      event,
      msg: note?.message ?? event,
    };
    write(`${JSON.stringify(line)}\n`);
  };
}
