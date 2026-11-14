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
 */

import { randomInt, randomUUID } from "node:crypto";

import type { CommandResult, CommandTiming, EngineStats } from "@marketlab/contracts";
import {
  Exchange,
  MarketSimulator,
  paise,
  type Command,
  type EngineEvent,
  type MarketConfig,
} from "@marketlab/engine";

import {
  FLOW_IDS,
  GUEST_CASH,
  GUEST_PREFIX,
  MAKER_PREFIX,
  type InstrumentConfig,
} from "./instruments.js";
import type { CommandLog, LogEntry, Session } from "./log/types.js";
import { MarketData } from "./market-data.js";
import { toEventView } from "./serialize.js";

const TICK_FLUSH_MS = 30_000;
const LATENCY_SAMPLES = 4_096;

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
  replay = { entries: 0, ms: 0 };

  private readonly sims: MarketSimulator[];
  private readonly now: () => number;
  private seq = 0;
  private pendingTicks = 0;
  private firstPendingTickAt = 0;
  private lastTickAt = 0;
  private lastFlushAt: number;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private failure: unknown;
  private readonly listeners = new Set<(update: HostUpdate) => void>();

  private constructor(
    private readonly options: HostOptions,
    session: Session,
  ) {
    this.now = options.now ?? Date.now;
    this.session = session;
    this.startedAt = this.now();
    this.lastFlushAt = this.startedAt;

    const markets: MarketConfig[] = [...options.instruments];
    this.exchange = new InstrumentedExchange(markets);
    this.data = new MarketData(options.instruments);

    // Bot accounts are derived from configuration, never logged.
    for (const i of options.instruments) {
      this.exchange.accounts.open(`${MAKER_PREFIX}${i.symbol}`, paise(GUEST_CASH * 1_000), {
        [i.symbol]: 10_000_000,
      });
    }
    const holdings = Object.fromEntries(options.instruments.map((i) => [i.symbol, 50_000]));
    for (const id of FLOW_IDS) this.exchange.accounts.open(id, paise(GUEST_CASH * 100), holdings);

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
  }

  /** Opens (or resumes) the session and replays its log. */
  static async start(options: HostOptions): Promise<EngineHost> {
    const now = options.now ?? Date.now;
    const session = await options.log.openSession(
      now(),
      options.sessionMaxAgeMs,
      options.seed ?? randomInt(1, 2 ** 31 - 1),
    );
    const host = new EngineHost(options, session);
    const started = performance.now();
    for (const entry of session.entries) host.apply(entry);
    host.seq = session.entries.length;
    host.replay = { entries: session.entries.length, ms: Math.round(performance.now() - started) };

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
    await this.serial(() => this.maybeFlushTicks(true)).catch(() => undefined);
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

  private serial<T>(work: () => Promise<T>): Promise<T> {
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
