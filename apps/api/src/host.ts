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
 *   command, or every 30 seconds.
 * - Snapshots. Replaying a full day of ticks takes about a minute, so every
 *   few minutes (and on shutdown) the host stores a snapshot of its state.
 *   Startup restores the latest one, checks its hash, and replays only the
 *   entries after it. A snapshot that fails any check is ignored and the whole
 *   log is replayed instead. See docs/adr/0006-startup-budget-and-snapshots.md.
 */

import { randomInt, randomUUID } from "node:crypto";

import type { CommandResult, CommandTiming, EngineStats } from "@marketlab/contracts";
import {
  Exchange,
  MarketSimulator,
  paise,
  type Command,
  type EngineEvent,
  type ExchangeState,
  type MarketConfig,
  type SimulatorState,
} from "@marketlab/engine";

import {
  FLOW_IDS,
  GUEST_CASH,
  GUEST_PREFIX,
  MAKER_PREFIX,
  type InstrumentConfig,
} from "./instruments.js";
import type { CommandLog, LogEntry, Session, StoredSnapshot } from "./log/types.js";
import { MarketData, type MarketDataState } from "./market-data.js";
import { toEventView } from "./serialize.js";

const TICK_FLUSH_MS = 30_000;
const LATENCY_SAMPLES = 4_096;
const SNAPSHOT_VERSION = 1;
export const DEFAULT_SNAPSHOT_MS = 10 * 60_000;

/** What a snapshot holds: the engine, the bots' positions in their random sequences, and the read models. */
interface HostState {
  readonly version: number;
  /** The instruments the state was built for; a changed configuration invalidates it. */
  readonly instruments: string;
  readonly exchange: ExchangeState;
  readonly simulators: readonly SimulatorState[];
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
}

export class HostUnavailableError extends Error {
  override name = "HostUnavailableError";
}

/** Exchange that records how long each command takes inside the engine. */
class InstrumentedExchange extends Exchange {
  private readonly samples = new Float64Array(LATENCY_SAMPLES);
  commands = 0;
  lastUs = 0;

  override submit(command: Command): EngineEvent[] {
    const start = process.hrtime.bigint();
    const events = super.submit(command);
    this.lastUs = Number(process.hrtime.bigint() - start) / 1_000;
    this.samples[this.commands % LATENCY_SAMPLES] = this.lastUs;
    this.commands += 1;
    return events;
  }

  percentiles(): { p50: number; p99: number } {
    const n = Math.min(this.commands, LATENCY_SAMPLES);
    if (n === 0) return { p50: 0, p99: 0 };
    const sorted = Array.from(this.samples.subarray(0, n)).sort((a, b) => a - b);
    const at = (q: number) =>
      Math.round((sorted[Math.min(n - 1, Math.floor(q * n))] ?? 0) * 10) / 10;
    return { p50: at(0.5), p99: at(0.99) };
  }
}

export class EngineHost {
  readonly exchange: InstrumentedExchange;
  readonly data: MarketData;
  readonly session: Session;
  readonly startedAt: number;
  /** How the last start rebuilt state: entries replayed, time taken, and the snapshot it began from (0: none). */
  replay = { entries: 0, ms: 0, snapshotSeq: 0 };

  private readonly sims: MarketSimulator[];
  private readonly now: () => number;
  private seq = 0;
  private pendingTicks = 0;
  private firstPendingTickAt = 0;
  private lastTickAt = 0;
  private lastFlushAt: number;
  private lastSnapshotAt: number;
  private lastSnapshotSeq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private failure: unknown;
  private readonly listeners = new Set<(update: HostUpdate) => void>();

  private constructor(
    private readonly options: HostOptions,
    session: Session,
    restored?: HostState,
  ) {
    this.now = options.now ?? Date.now;
    this.session = session;
    this.startedAt = this.now();
    this.lastFlushAt = this.startedAt;
    this.lastSnapshotAt = this.startedAt;

    const markets: MarketConfig[] = [...options.instruments];
    this.exchange = new InstrumentedExchange(markets);
    this.data = new MarketData(options.instruments);

    if (restored) {
      this.exchange.load(restored.exchange);
      this.exchange.commands = restored.commands;
      this.data.load(restored.data);
    } else {
      // Bot accounts are derived from configuration, never logged.
      for (const i of options.instruments) {
        this.exchange.accounts.open(`${MAKER_PREFIX}${i.symbol}`, paise(GUEST_CASH * 1_000), {
          [i.symbol]: 10_000_000,
        });
      }
      const holdings = Object.fromEntries(options.instruments.map((i) => [i.symbol, 50_000]));
      for (const id of FLOW_IDS) this.exchange.accounts.open(id, paise(GUEST_CASH * 100), holdings);
    }

    this.sims = options.instruments.map(
      (i, index) =>
        new MarketSimulator(this.exchange, {
          symbol: i.symbol,
          seed: (session.seed + index * 7_919) >>> 0,
          makerId: `${MAKER_PREFIX}${i.symbol}`,
          takerIds: FLOW_IDS,
          levels: 12,
          levelSize: i.levelSize,
          levelGapTicks: i.levelGapTicks,
          volatilityTicks: i.volatilityTicks,
          jumpProbability: 0.02,
          takerProbability: 0.12,
          maxTakerQty: Math.max(5, Math.round(i.levelSize * 0.8)),
        }),
    );
    if (restored) {
      if (restored.simulators.length !== this.sims.length) throw new Error("Simulators differ");
      this.sims.forEach((sim, index) => {
        const state = restored.simulators[index];
        if (state) sim.load(state);
      });
    }
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
    for (const entry of tail) host.apply(entry);
    host.seq = session.entries.length;
    host.replay = {
      entries: tail.length,
      ms: Math.round(performance.now() - started),
      snapshotSeq,
    };

    const warmup = options.warmupTicks ?? 0;
    if (session.entries.length === 0 && warmup > 0) {
      const end = now();
      for (let i = 0; i < warmup; i++) host.tick(end - (warmup - 1 - i) * options.tickMs);
      await host.serial(() => host.maybeFlushTicks(true));
    }
    return host;
  }

  // Lifecycle --------------------------------------------------------------

  startClock(): void {
    this.timer ??= setInterval(() => {
      void this.serial(() => {
        this.tick();
        return this.maybeFlushTicks(false);
      }).catch(() => undefined);
    }, this.options.tickMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.serial(async () => {
      await this.maybeFlushTicks(true);
      await this.maybeSnapshot(true); // so the next start has almost nothing to replay
    }).catch(() => undefined);
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
    const events = this.sims.flatMap((sim) => sim.step());
    if (this.pendingTicks === 0) this.firstPendingTickAt = at;
    this.pendingTicks += 1;
    this.lastTickAt = at;
    this.publish(events, at);
    return events;
  }

  async openGuest(): Promise<string> {
    const accountId = `${GUEST_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await this.serial(async () => {
      await this.maybeFlushTicks(true); // keep the log in application order
      const entry: LogEntry = { kind: "open", accountId, at: this.now() };
      await this.persist(entry);
      this.apply(entry);
    });
    return accountId;
  }

  async submit(command: Command): Promise<CommandResult> {
    const receivedAt = this.now();
    const enqueued = performance.now();
    return this.serial(async () => {
      const queueMs = Math.round((performance.now() - enqueued) * 1000) / 1000;
      const at = this.now();
      const entry: LogEntry = { kind: "command", command, at };

      const persistStart = performance.now();
      await this.maybeFlushTicks(true);
      await this.persist(entry);
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

  /** Applies a logged entry. Shared by live operation and replay. */
  private apply(entry: LogEntry): void {
    switch (entry.kind) {
      case "open":
        this.exchange.accounts.open(entry.accountId, GUEST_CASH);
        this.data.registerHuman(entry.accountId);
        return;
      case "ticks":
        // Ticks run on a steady interval, so their times are interpolated
        // between the first and last; they only date trades and candles.
        for (let i = 0; i < entry.count; i++) {
          const fraction = entry.count === 1 ? 1 : i / (entry.count - 1);
          this.tick(Math.round(entry.from + (entry.at - entry.from) * fraction));
        }
        this.pendingTicks = 0;
        return;
      case "command":
        this.applyCommand(entry.command, entry.at);
        return;
    }
  }

  private applyCommand(command: Command, at: number): EngineEvent[] {
    const events = this.exchange.submit(command);
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
      exchange: this.exchange.serialize(),
      simulators: this.sims.map((sim) => sim.serialize()),
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
      await this.options.log.append(this.session.id, this.seq + 1, entry);
      this.seq += 1;
    } catch (error) {
      // The engine may now hold ticks the log does not: stop accepting work and
      // let the process restart, which replays the log into a consistent state.
      this.failure = error;
      this.options.onFatal?.(error);
      throw new HostUnavailableError("The command log is unavailable");
    }
  }

  /** Runs work in the single-writer queue, after everything already queued. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  // Reads ------------------------------------------------------------------

  stats(): EngineStats {
    const { p50, p99 } = this.exchange.percentiles();
    let openOrders = 0;
    for (const id of this.exchange.accounts.ids()) {
      openOrders += this.exchange.openOrders(id).length;
    }
    return {
      commands: this.exchange.commands,
      trades: this.data.totalTrades(),
      openOrders,
      p50Us: p50,
      p99Us: p99,
    };
  }
}

const instrumentsKey = (instruments: readonly InstrumentConfig[]): string =>
  JSON.stringify(instruments);
