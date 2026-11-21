/**
 * The engine host: owns the in-memory exchange and keeps it durable.
 *
 * - Single writer. Every mutation (a market tick, a guest opening an account, a
 *   user command) runs through one promise queue, so the engine sees one input
 *   at a time, in the same order the log records them.
 * - Write-ahead. A user command is appended to the command log *before* the
 *   engine applies it. If the append fails, the command is not applied and the
 *   caller gets an error; the engine never holds state the log cannot rebuild.
 * - Replay. On startup the session's log is replayed through the same code
 *   path, which rebuilds the engine and every read model exactly.
 * - Market ticks are cheap and frequent, so they are counted, not logged one by
 *   one: the count is flushed as a single `ticks` entry before the next user
 *   command, every 30 seconds while the exchange is active, and on shutdown.
 * - Snapshots. Replaying a full day of ticks takes about a minute, so every
 *   few minutes while active (and on shutdown) the host stores a snapshot of
 *   its state. Startup restores the latest one, checks its hash, and replays
 *   only the entries after it. A snapshot that fails any check is ignored and
 *   the whole log is replayed instead. See docs/adr/0006-startup-budget-and-snapshots.md.
 * - Idle-aware. With no stream client and no user activity for five minutes,
 *   the host stops its periodic writes and suspends the log, so a serverless
 *   database can scale to zero; the market keeps ticking in memory. Bot ticks
 *   made while idle are logged when activity returns or on shutdown, and lost
 *   in a crash before then, which costs no user any order or balance. See
 *   docs/adr/0007-idle-aware-persistence.md.
 * - Sessions. Once the session is `sessionMaxAgeMs` old and the host is idle,
 *   the next beat of the clock ends it and starts a fresh one in place, so an
 *   always-on server does not replay an ever-longer session. A restart does
 *   the same for a session that aged while the process was down.
 */

import { randomInt, randomUUID } from "node:crypto";

import type {
  CommandResult,
  CommandTiming,
  EngineLatency,
  EngineStats,
} from "@marketlab/contracts";
import {
  CountingExchange,
  SessionEngine,
  type Command,
  type EngineEvent,
  type SessionConfig,
  type SessionState,
} from "@marketlab/engine";

import type { EmitEvent } from "./events.js";
import { GUEST_CASH, GUEST_PREFIX, type InstrumentConfig } from "./instruments.js";
import {
  LockHeldError,
  LogHeadMovedError,
  type CommandLog,
  type LogEntry,
  type Session,
  type StoredSnapshot,
} from "./log/types.js";
import { MarketData, type MarketDataState } from "./market-data.js";
import { toEventView } from "./serialize.js";

const TICK_FLUSH_MS = 30_000;
/**
 * With no stream client connected and no user activity for this long, the
 * host stops its periodic log writes and suspends the log (ADR 0007).
 */
export const IDLE_AFTER_MS = 5 * 60_000;
const LATENCY_SAMPLES = 4_096;
const SNAPSHOT_VERSION = 2;
export const DEFAULT_SNAPSHOT_MS = 10 * 60_000;

/** What a snapshot holds: the session engine (exchange and simulators) and the read models. */
interface HostState {
  readonly version: number;
  /** The instruments the state was built for; a changed configuration invalidates it. */
  readonly instruments: string;
  readonly session: SessionState;
  readonly data: MarketDataState;
  /** Engine commands processed so far in the session, for the statistics. */
  readonly commands: number;
}

/** One batch of engine output, pushed to stream subscribers. */
export interface HostUpdate {
  readonly at: number;
  readonly events: readonly EngineEvent[];
  readonly symbols: ReadonlySet<string>;
  /** Guest accounts whose orders or balances changed. */
  readonly accounts: ReadonlySet<string>;
}

export interface HostOptions {
  readonly log: CommandLog;
  readonly instruments: readonly InstrumentConfig[];
  readonly tickMs: number;
  readonly sessionMaxAgeMs: number;
  readonly now?: () => number;
  /** Fixed seed for tests; random otherwise. */
  readonly seed?: number;
  /**
   * Ticks of history to simulate when a new session starts, so charts are not
   * empty. Backdated and logged as one `ticks` entry, so replay stays exact.
   */
  readonly warmupTicks?: number;
  /** Called when the log can no longer be written; the process should restart. */
  readonly onFatal?: (error: unknown) => void;
  /**
   * Milliseconds between snapshots; 0 turns them off, for saving and for
   * restoring. Default ten minutes.
   */
  readonly snapshotMs?: number;
  /** Called for problems the host recovers from (an unusable or unsaved snapshot). */
  readonly onWarning?: (message: string, error?: unknown) => void;
  /** Lifecycle events: replay verified, snapshot saved, log suspended and resumed. */
  readonly onEvent?: EmitEvent;
  /** How long without watchers or activity before the host goes idle; default `IDLE_AFTER_MS`. */
  readonly idleAfterMs?: number;
  /**
   * Guest accounts this session accepts; `openGuest` refuses more with
   * `GuestLimitError`. Guests already in the log are replayed regardless.
   */
  readonly maxGuests?: number;
  /**
   * Called once if, waking from an idle stretch, the host finds that another
   * process has taken over the log (a deploy, ADR 0009). The host then refuses
   * all work but is not failed: the process should wait to be stopped, not
   * restart and contend for the log.
   */
  readonly onSuperseded?: (error: unknown) => void;
}

/**
 * What the final flush on shutdown did: `saved` the pending ticks and a
 * snapshot, or `owned-elsewhere`: the log was suspended and another process
 * has since taken it over, so this one must not write (ADR 0007).
 */
export type FinalFlush = "saved" | "owned-elsewhere";

export class HostUnavailableError extends Error {
  override name = "HostUnavailableError";
}

/** A command for an account that is not in the current session (it has rolled over). */
export class SessionEndedError extends Error {
  override name = "SessionEndedError";
}

/** The session already has `maxGuests` guest accounts. */
export class GuestLimitError extends Error {
  override name = "GuestLimitError";
}

/** The most recent engine times of one kind of command, microseconds. */
class LatencyWindow {
  private readonly samples = new Float64Array(LATENCY_SAMPLES);
  private count = 0;

  record(us: number): void {
    this.samples[this.count % LATENCY_SAMPLES] = us;
    this.count += 1;
  }

  summary(): EngineLatency {
    const n = Math.min(this.count, LATENCY_SAMPLES);
    if (n === 0) return { p50Us: 0, p99Us: 0, samples: 0 };
    const sorted = Array.from(this.samples.subarray(0, n)).sort((a, b) => a - b);
    const at = (q: number) =>
      Math.round((sorted[Math.min(n - 1, Math.floor(q * n))] ?? 0) * 10) / 10;
    return { p50Us: at(0.5), p99Us: at(0.99), samples: n };
  }
}

/**
 * Exchange that records how long each command takes inside the engine, kept
 * apart for bot and visitor commands: they are different work under different
 * conditions (see apps/api/src/bench/latency.ts), so one median would describe
 * neither.
 */
class InstrumentedExchange extends CountingExchange {
  readonly bots = new LatencyWindow();
  readonly visitors = new LatencyWindow();
  lastUs = 0;

  override submit(command: Command): EngineEvent[] {
    return this.timed(command, this.bots);
  }

  /** A visitor's command, applied live (replayed ones count with the rest). */
  submitVisitor(command: Command): EngineEvent[] {
    return this.timed(command, this.visitors);
  }

  private timed(command: Command, window: LatencyWindow): EngineEvent[] {
    const start = process.hrtime.bigint();
    const events = super.submit(command); // counts the command
    this.lastUs = Number(process.hrtime.bigint() - start) / 1_000;
    window.record(this.lastUs);
    return events;
  }
}

/**
 * Everything that belongs to one market session: replaced whole when the
 * session rolls over, so no account, order or statistic outlives it.
 */
interface SessionParts {
  readonly session: Session;
  readonly config: SessionConfig;
  readonly engine: SessionEngine<InstrumentedExchange>;
  readonly data: MarketData;
}

function sessionParts(options: HostOptions, session: Session, restored?: HostState): SessionParts {
  const config: SessionConfig = {
    seed: session.seed,
    instruments: options.instruments,
    guestCash: GUEST_CASH,
  };
  const engine = new SessionEngine(config, {
    createExchange: (markets) => new InstrumentedExchange(markets),
    ...(restored ? { state: restored.session } : {}),
  });
  const data = new MarketData(options.instruments);
  if (restored) {
    engine.exchange.commands = restored.commands;
    data.load(restored.data);
  }
  return { session, config, engine, data };
}

export class EngineHost {
  readonly startedAt: number;
  /** How the last start rebuilt state: entries replayed, time taken, and the snapshot it began from (0: none). */
  replay = { entries: 0, ms: 0, snapshotSeq: 0 };

  private parts: SessionParts;
  private readonly now: () => number;
  private seq = 0;
  private pendingTicks = 0;
  private firstPendingTickAt = 0;
  /** State hash before the first unlogged tick: what the next `ticks` entry is applied to. */
  private pendingTicksHash = "";
  private hashMismatchReported = false;
  private lastTickAt = 0;
  private lastFlushAt: number;
  private lastSnapshotAt: number;
  private lastSnapshotSeq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private failure: unknown;
  /** Set when shutdown begins: new work is refused, queued work still runs. */
  private closing = false;
  /** Set when another process has taken over the log; see `onSuperseded`. */
  private supersededBy: unknown;
  /** How many stream clients are watching; set by `watch`. */
  private watchers: () => number = () => 0;
  /** The last user command, guest account or replay read. */
  private lastActivityAt: number;
  /**
   * True from the moment the host suspends the log for being idle until it
   * has stored a snapshot after waking: periodic persistence is paused.
   */
  private idleStretch = false;
  /** True from the host suspending the log until a write has resumed it. */
  private logSuspended = false;
  private readonly listeners = new Set<(update: HostUpdate) => void>();
  private readonly sessionListeners = new Set<(sessionId: number) => void>();

  private constructor(
    private readonly options: HostOptions,
    session: Session,
    restored?: HostState,
  ) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFlushAt = this.startedAt;
    this.lastSnapshotAt = this.startedAt;
    this.lastActivityAt = this.startedAt;
    this.parts = sessionParts(options, session, restored);
  }

  /** The market session being played. */
  get session(): Session {
    return this.parts.session;
  }

  /** The seed and rules of this session: with the log, everything needed to rebuild it anywhere. */
  get sessionConfig(): SessionConfig {
    return this.parts.config;
  }

  get exchange(): InstrumentedExchange {
    return this.parts.engine.exchange;
  }

  get data(): MarketData {
    return this.parts.data;
  }

  private get engine(): SessionEngine<InstrumentedExchange> {
    return this.parts.engine;
  }

  /**
   * Builds a host from a stored snapshot, or returns undefined (with a warning)
   * if the snapshot cannot be trusted: wrong version, different instruments,
   * newer than the log, a hash that does not match, or a failed audit.
   */
  private static fromSnapshot(
    options: HostOptions,
    session: Session,
    stored: StoredSnapshot,
  ): EngineHost | undefined {
    try {
      if (stored.seq > session.entries.length) throw new Error("it is ahead of the log");
      const state = JSON.parse(stored.state) as HostState;
      if (state.version !== SNAPSHOT_VERSION) throw new Error("it has another format version");
      if (state.instruments !== instrumentsKey(options.instruments)) {
        throw new Error("the instruments have changed");
      }
      const host = new EngineHost(options, session, state);
      if (host.exchange.stateHash() !== stored.stateHash)
        throw new Error("its hash does not match");
      const problems = host.exchange.audit();
      if (problems.length > 0) throw new Error(`it fails the audit (${problems[0] ?? ""})`);
      host.lastSnapshotSeq = stored.seq;
      return host;
    } catch (error) {
      options.onWarning?.(
        `Ignoring the snapshot at entry ${String(stored.seq)}; replaying the whole log instead`,
        error,
      );
      return undefined;
    }
  }

  /** Opens (or resumes) the session and replays its log. */
  static async start(options: HostOptions): Promise<EngineHost> {
    const now = options.now ?? Date.now;
    const session = await options.log.openSession(
      now(),
      options.sessionMaxAgeMs,
      options.seed ?? randomInt(1, 2 ** 31 - 1),
    );
    const started = performance.now();
    const stored =
      (options.snapshotMs ?? DEFAULT_SNAPSHOT_MS) > 0
        ? await options.log.loadSnapshot(session.id)
        : null;
    const restored = stored ? EngineHost.fromSnapshot(options, session, stored) : undefined;
    const host = restored ?? new EngineHost(options, session);
    const snapshotSeq = restored && stored ? stored.seq : 0;

    const tail = session.entries.slice(snapshotSeq);
    tail.forEach((entry, index) => {
      host.apply(entry, snapshotSeq + index + 1);
    });
    host.seq = session.entries.length;
    host.replay = {
      entries: tail.length,
      ms: Math.round(performance.now() - started),
      snapshotSeq,
    };
    if (!host.hashMismatchReported) {
      options.onEvent?.("replay_verified", {
        session: session.id,
        entries: tail.length,
        ms: host.replay.ms,
        snapshotSeq,
        seq: host.seq,
        stateHash: host.exchange.stateHash(),
      });
    }

    if (session.entries.length === 0) await host.serial(() => host.warmUp());
    return host;
  }

  /**
   * Simulates `warmupTicks` of history for a new session, backdated so they
   * end now, and logs them as one entry. Must run inside `serial`.
   */
  private async warmUp(): Promise<void> {
    const warmup = this.options.warmupTicks ?? 0;
    if (warmup === 0) return;
    const end = this.now();
    for (let i = 0; i < warmup; i++) this.tick(end - (warmup - 1 - i) * this.options.tickMs);
    await this.maybeFlushTicks(true);
  }

  // Lifecycle --------------------------------------------------------------

  startClock(): void {
    this.timer ??= setInterval(() => {
      void this.clockTick();
    }, this.options.tickMs);
  }

  /** Tells the host how many stream clients are watching; while any are, it stays active. */
  watch(watchers: () => number): void {
    this.watchers = watchers;
  }

  /**
   * True while someone is watching or used the exchange recently. Only then
   * does the host write ticks and snapshots on its own; user commands are
   * always logged.
   */
  get active(): boolean {
    const idleAfter = this.options.idleAfterMs ?? IDLE_AFTER_MS;
    return this.watchers() > 0 || this.now() - this.lastActivityAt < idleAfter;
  }

  /**
   * One beat of the market clock, in the write queue: the market always
   * ticks. While active, ticks are flushed every 30 seconds and snapshots
   * taken as usual. On becoming idle the host logs what it has, stores a
   * snapshot and suspends the log, so the database can scale to zero; it then
   * writes nothing until activity returns. Waking, it flushes the idle ticks
   * as one entry and stores a snapshot at once, so a restart soon after does
   * not replay them. An idle session that has reached `sessionMaxAgeMs` is
   * replaced by a new one (`rollover`). Never rejects: a failure stops the
   * host (`onFatal`).
   */
  clockTick(): Promise<void> {
    return this.serial(async () => {
      if (this.failure !== undefined || this.superseded) return;
      if (!this.active && this.now() - this.session.startedAt >= this.options.sessionMaxAgeMs) {
        await this.rollover();
        return;
      }
      this.tick();
      const { log } = this.options;
      if (this.active) {
        await this.maybeFlushTicks(this.idleStretch); // resumes the log if suspended
        if (this.idleStretch) {
          await this.maybeSnapshot(true);
          this.idleStretch = false;
        }
      } else if (log.connected) {
        await this.maybeFlushTicks(true);
        await this.maybeSnapshot(true);
        await log.suspend();
        this.idleStretch = true;
        this.logSuspended = true;
        this.options.onEvent?.("log_suspended", { session: this.session.id, seq: this.seq });
      }
    }).catch((error: unknown) => {
      if (!this.superseded) this.fail(error);
    });
  }

  /**
   * Ends the current session and starts the next, in the write queue, so
   * every command waits for it and none straddles the two. Only called while
   * idle: nobody is watching and nobody has acted for `idleAfterMs`.
   *
   * 1. Takes the log back if it was suspended, logs the pending ticks and
   *    stores a final snapshot of the old session, which stays in the log
   *    unchanged.
   * 2. Opens a new session with a new seed, and replaces the engine, the read
   *    models and the latency windows: no account, balance or open order
   *    carries over (play money). Tokens for the old session stop verifying.
   * 3. Tells `onSessionStart` listeners (the stream hub ends its streams),
   *    runs the warm-up, logs it and stores a snapshot at once.
   * 4. Deletes sessions older than the retention period.
   */
  private async rollover(): Promise<void> {
    const started = performance.now();
    await this.claimLog();
    await this.maybeFlushTicks(true);
    await this.maybeSnapshot(true);
    const ended = { session: this.session.id, seq: this.seq }; // the old session's last entry

    const session = await this.options.log.openSession(
      this.now(),
      this.options.sessionMaxAgeMs,
      this.options.seed ?? randomInt(1, 2 ** 31 - 1),
    );
    if (session.id === ended.session || session.entries.length > 0) {
      throw new Error(`Rollover found session ${String(session.id)} already in use`);
    }
    this.parts = sessionParts(this.options, session);
    this.seq = 0;
    this.pendingTicks = 0;
    this.pendingTicksHash = "";
    this.hashMismatchReported = false;
    this.lastSnapshotSeq = 0;
    this.lastFlushAt = this.now();
    this.lastSnapshotAt = this.now();
    this.idleStretch = false;
    for (const listener of this.sessionListeners) listener(session.id);

    const warming = performance.now();
    await this.warmUp();
    const warmupMs = Math.round(performance.now() - warming);
    await this.maybeSnapshot(true);
    try {
      await this.options.log.pruneSessions(this.now());
    } catch (error) {
      this.options.onWarning?.("Could not delete old sessions; the new one is unaffected", error);
    }
    this.options.onEvent?.("session_rolled_over", {
      from: ended.session,
      fromSeq: ended.seq,
      session: session.id,
      seq: this.seq,
      warmupTicks: this.options.warmupTicks ?? 0,
      warmupMs,
      ms: Math.round(performance.now() - started),
    });
  }

  /** Calls `listener` with the new session's id each time a session rolls over. */
  onSessionStart(listener: (sessionId: number) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** True once another process has taken over the log: all work is refused, without a failure. */
  get superseded(): boolean {
    return this.supersededBy !== undefined;
  }

  /**
   * Shutdown, step 1: refuse new commands, guest accounts and replay
   * checkpoints (they fail with `HostUnavailableError`, before reaching the
   * queue, so they are never logged or applied). Work already queued still runs.
   */
  beginShutdown(): void {
    this.closing = true;
  }

  /** Stops the market clock: no more ticks. */
  stopClock(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves once everything queued so far has finished (the queue is first in, first out). */
  drain(): Promise<void> {
    return this.serial(() => Promise.resolve());
  }

  /**
   * Shutdown, step 4, after `drain`: logs the pending ticks and stores a final
   * snapshot, so the next start has almost nothing to replay. A suspended log
   * is resumed first; if another process has taken the lock or written to the
   * session meanwhile, this process no longer owns the log and writes nothing,
   * which is not a failure: only unwatched bot ticks are lost (ADR 0007).
   * Rejects, through the usual `onFatal`, if the log cannot be written.
   */
  finalFlush(): Promise<FinalFlush> {
    return this.serial(async () => {
      if (this.superseded) return "owned-elsewhere";
      if (this.failure !== undefined) {
        throw new HostUnavailableError("The command log is unavailable");
      }
      try {
        await this.resumeLog();
      } catch (error) {
        if (error instanceof LockHeldError || error instanceof LogHeadMovedError) {
          return "owned-elsewhere";
        }
        throw error;
      }
      await this.maybeFlushTicks(true);
      await this.maybeSnapshot(true);
      return "saved";
    });
  }

  /** Refuses new work, stops the clock, then logs pending ticks and stores a final snapshot. */
  async stop(): Promise<FinalFlush | undefined> {
    this.beginShutdown();
    this.stopClock();
    return this.finalFlush().catch(() => undefined);
  }

  /** Throws if the host can no longer take new work. */
  private assertOpen(): void {
    if (this.closing) throw new HostUnavailableError("The exchange is shutting down");
  }

  subscribe(listener: (update: HostUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get healthy(): boolean {
    return this.failure === undefined;
  }

  get sequence(): number {
    return this.seq;
  }

  // Commands ---------------------------------------------------------------

  /** Advances the market one tick immediately (tests and replay use this). */
  tick(at = this.now()): EngineEvent[] {
    if (this.pendingTicks === 0) {
      this.firstPendingTickAt = at;
      this.pendingTicksHash = this.exchange.stateHash();
    }
    const events = this.engine.tick();
    this.pendingTicks += 1;
    this.lastTickAt = at;
    this.publish(events, at);
    return events;
  }

  async openGuest(): Promise<string> {
    this.assertOpen();
    const accountId = `${GUEST_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.lastActivityAt = this.now();
    await this.serial(async () => {
      // Checked in the queue, so concurrent requests cannot both take the last place.
      const max = this.options.maxGuests;
      if (max !== undefined && this.data.humanCount >= max) {
        throw new GuestLimitError(`The session already has ${String(max)} guests`);
      }
      await this.maybeFlushTicks(true); // keep the log in application order
      const entry: LogEntry = {
        kind: "open",
        accountId,
        at: this.now(),
        h: this.exchange.stateHash(),
      };
      await this.persist(entry);
      this.engine.openGuest(accountId);
      this.data.registerHuman(accountId);
    });
    return accountId;
  }

  async submit(command: Command): Promise<CommandResult> {
    this.assertOpen();
    const receivedAt = this.now();
    this.lastActivityAt = receivedAt;
    const enqueued = performance.now();
    return this.serial(async () => {
      // The session may have rolled over while this command waited in the
      // queue: its account belongs to the old one. Refuse it before logging.
      if (!this.exchange.accounts.has(command.accountId)) {
        throw new SessionEndedError("That account belongs to a session that has ended");
      }
      const queueMs = Math.round((performance.now() - enqueued) * 1000) / 1000;
      const at = this.now();
      const persistStart = performance.now();
      await this.maybeFlushTicks(true);
      await this.persist({ kind: "command", command, at, h: this.exchange.stateHash() });
      const persistMs = Math.round((performance.now() - persistStart) * 100) / 100;

      const events = this.applyCommand(command, at);
      const timing: CommandTiming = {
        receivedAt,
        queueMs,
        persistMs,
        engineUs: Math.round(this.exchange.lastUs * 10) / 10,
      };

      const accepted = events.find((e) => e.type === "order.accepted");
      const rejected = events.find((e) => e.type === "order.rejected");
      const orderId =
        accepted?.type === "order.accepted"
          ? accepted.order.id
          : command.kind === "cancel"
            ? command.orderId
            : null;
      if (accepted?.type === "order.accepted") this.data.setTiming(accepted.order.id, timing);

      return {
        ok: rejected === undefined,
        orderId,
        rejectReason: rejected?.type === "order.rejected" ? rejected.reason : null,
        events: events.map((e) => toEventView(e, at)),
        timing,
      };
    });
  }

  // Internals --------------------------------------------------------------

  /**
   * Replays one logged entry through the session engine, the same code a
   * browser replay runs. If the entry recorded the state hash it was applied
   * to, the replay checks that it is in that state: a mismatch means the log
   * and the engine no longer agree, which is reported once.
   */
  private apply(entry: LogEntry, seq: number): void {
    if (entry.h !== undefined && !this.hashMismatchReported) {
      const actual = this.exchange.stateHash();
      if (actual !== entry.h) {
        this.hashMismatchReported = true;
        this.options.onWarning?.(
          `Replay diverged before log entry ${String(seq)}: recorded ${entry.h}, rebuilt ${actual}`,
        );
      }
    }
    if (entry.kind === "open") this.data.registerHuman(entry.accountId);
    this.engine.apply(entry, (events, at) => {
      this.publish(events, at);
    });
  }

  private applyCommand(command: Command, at: number): EngineEvent[] {
    const events = this.exchange.submitVisitor(command);
    this.publish(events, at);
    return events;
  }

  private publish(events: readonly EngineEvent[], at: number): void {
    if (events.length === 0) return;
    const { accounts } = this.data.ingest(events, at);
    if (this.listeners.size === 0) return;
    const symbols = new Set<string>();
    for (const e of events) {
      if (e.type === "order.accepted") symbols.add(e.order.symbol);
      else if (e.type === "trade" || e.type === "order.rested") symbols.add(e.symbol);
      else if (e.type === "order.cancelled") {
        const symbol = this.data.symbolOf(e.orderId);
        if (symbol) symbols.add(symbol);
      }
    }
    const update: HostUpdate = { at, events, symbols, accounts };
    for (const listener of this.listeners) listener(update);
  }

  /** Logs any ticks not yet in the log. Must run inside `serial`. */
  flush(): Promise<void> {
    const snapshotMs = this.lastSnapshotAt;
    this.lastSnapshotAt = Infinity; // a plain flush never takes a snapshot
    return this.maybeFlushTicks(true).finally(() => {
      this.lastSnapshotAt = snapshotMs;
    });
  }

  private async maybeFlushTicks(force: boolean): Promise<void> {
    if (this.pendingTicks === 0) return;
    if (!force && this.now() - this.lastFlushAt < TICK_FLUSH_MS) return;
    const count = this.pendingTicks;
    await this.persist({
      kind: "ticks",
      count,
      from: this.firstPendingTickAt,
      at: this.lastTickAt,
      h: this.pendingTicksHash,
    });
    this.pendingTicks -= count;
    this.lastFlushAt = this.now();
    await this.maybeSnapshot(false);
  }

  /**
   * Stores a snapshot if one is due. Only called inside the write queue with no
   * unlogged ticks, so the state is exactly "the log up to `seq`, applied".
   * Failing to store one is not fatal: the log is still complete.
   */
  private async maybeSnapshot(force: boolean): Promise<void> {
    const every = this.options.snapshotMs ?? DEFAULT_SNAPSHOT_MS;
    if (every <= 0 || this.failure !== undefined || this.pendingTicks > 0) return;
    if (this.seq === 0 || this.seq === this.lastSnapshotSeq) return;
    if (!force && this.now() - this.lastSnapshotAt < every) return;
    try {
      await this.options.log.saveSnapshot(this.session.id, this.snapshot());
      this.lastSnapshotAt = this.now();
      this.lastSnapshotSeq = this.seq;
      this.options.onEvent?.("snapshot_saved", { session: this.session.id, seq: this.seq });
    } catch (error) {
      this.lastSnapshotAt = this.now(); // try again after the usual interval, not every tick
      this.options.onWarning?.("Could not store a snapshot; the log is unaffected", error);
    }
  }

  /** The state after log entry `seq`, ready to store. */
  snapshot(): StoredSnapshot {
    const state: HostState = {
      version: SNAPSHOT_VERSION,
      instruments: instrumentsKey(this.options.instruments),
      session: this.engine.serialize(),
      data: this.data.serialize(),
      commands: this.exchange.commands,
    };
    return { seq: this.seq, stateHash: this.exchange.stateHash(), state: JSON.stringify(state) };
  }

  private async persist(entry: LogEntry): Promise<void> {
    if (this.failure !== undefined) {
      throw new HostUnavailableError("The command log is unavailable");
    }
    try {
      // After an idle stretch: reconnect, retake the lock, check nobody wrote.
      await this.resumeLog();
      await this.options.log.append(this.session.id, this.seq + 1, entry);
      this.seq += 1;
    } catch (error) {
      this.lostLog(error);
    }
  }

  /** Takes the log back if it was suspended, with the same failure handling as a write. */
  private async claimLog(): Promise<void> {
    try {
      await this.resumeLog();
    } catch (error) {
      this.lostLog(error);
    }
  }

  /** A write or resume failed: stand down or stop, and tell the caller. */
  private lostLog(error: unknown): never {
    if (error instanceof LockHeldError || error instanceof LogHeadMovedError) {
      // Another process owns the log now (a deploy took it over while this
      // one was idle): this one must never write again, but it has not failed.
      this.supersede(error);
      throw new HostUnavailableError("Another instance owns the command log");
    }
    // The engine may now hold ticks the log does not: stop accepting work and
    // let the process restart, which replays the log into a consistent state.
    this.fail(error);
    throw new HostUnavailableError("The command log is unavailable");
  }

  /** Refuses all further work and stops the clock; reports it once. */
  private supersede(error: unknown): void {
    if (this.superseded) return;
    this.supersededBy = error;
    this.closing = true;
    this.stopClock();
    this.options.onSuperseded?.(error);
  }

  /** Resumes the log if it was suspended (a no-op otherwise); throws if it cannot. */
  private async resumeLog(): Promise<void> {
    await this.options.log.resume(this.session.id, this.seq);
    if (this.logSuspended) {
      this.logSuspended = false;
      this.options.onEvent?.("log_resumed", { session: this.session.id, seq: this.seq });
    }
  }

  /** Stops accepting work and reports the failure once; the process should restart. */
  private fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.options.onFatal?.(error);
  }

  /** Runs work in the single-writer queue, after everything already queued. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * The point a replay must reach: the log sequence and the state hash after
   * it. Unlogged ticks are written first, inside the write queue, so the hash
   * is exactly "the log up to `seq`, applied".
   */
  checkpoint(): Promise<{ seq: number; stateHash: string; commands: number }> {
    if (this.closing) {
      return Promise.reject(new HostUnavailableError("The exchange is shutting down"));
    }
    this.lastActivityAt = this.now(); // a replay is starting
    return this.serial(async () => {
      await this.flush();
      return {
        seq: this.seq,
        stateHash: this.exchange.stateHash(),
        commands: this.exchange.commands,
      };
    });
  }

  /** Log entries after sequence `after`, for a replay. */
  readEntries(after: number, limit: number): Promise<LogEntry[]> {
    this.lastActivityAt = this.now(); // reconnects a suspended log; keep it for a while
    return this.options.log.readEntries(this.session.id, after, limit);
  }

  // Reads ------------------------------------------------------------------

  stats(): EngineStats {
    let openOrders = 0;
    for (const id of this.exchange.accounts.ids()) {
      openOrders += this.exchange.openOrders(id).length;
    }
    return {
      commands: this.exchange.commands,
      trades: this.data.totalTrades(),
      openOrders,
      bots: this.exchange.bots.summary(),
      visitors: this.exchange.visitors.summary(),
    };
  }
}

const instrumentsKey = (instruments: readonly InstrumentConfig[]): string =>
  JSON.stringify(instruments);
