/**
 * Replays a session's log step by step, with checkpoints for scrubbing and a
 * verdict on whether the result matches the server.
 *
 * - A *step* is one market tick or one guest entry. Position `p` means "the
 *   first `p` steps have been applied".
 * - Moving forward applies steps one at a time. Moving backward restores the
 *   nearest earlier checkpoint (taken every `checkpointEvery` steps) and moves
 *   forward from there, so a seek costs at most that many steps.
 * - Verification happens the first time the replay passes each point: before
 *   an entry that recorded the server's state hash, and at the end against the
 *   hash the server reported for the whole log. The first mismatch is kept.
 *
 * Pure: no clock, no I/O. A Web Worker drives it in the browser; tests drive
 * it directly.
 */

import type { Depth } from "./book.js";
import type { EngineEvent } from "./events.js";
import {
  CountingExchange,
  SessionEngine,
  stepTime,
  stepsIn,
  type LogEntry,
  type SessionConfig,
  type SessionState,
} from "./session.js";

/** Candle width shared by the live market data and the replay. */
export const CANDLE_MS = 15_000;
const MAX_CANDLES = 240;
const MAX_TRADES = 50;

export interface ReplayLog {
  readonly config: SessionConfig;
  readonly entries: readonly LogEntry[];
  /** The server's state hash after the last entry (log sequence `seq`). */
  readonly head: { readonly seq: number; readonly stateHash: string };
}

export type Verdict =
  | { readonly status: "pending" }
  | { readonly status: "verified"; readonly seq: number; readonly stateHash: string }
  | {
      readonly status: "diverged";
      /** The log entry after which the states differ; 0 means before the first entry. */
      readonly seq: number;
      readonly expected: string;
      readonly actual: string;
    };

/** Prices in paise. Candles and trades are never mutated once stored. */
export interface ReplayCandle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface ReplayTrade {
  readonly seq: number;
  readonly price: number;
  readonly qty: number;
  readonly aggressor: "buy" | "sell";
  readonly time: number;
}

interface SymbolView {
  readonly candles: readonly ReplayCandle[];
  /** Newest first. */
  readonly trades: readonly ReplayTrade[];
  readonly open: number;
  readonly last: number;
  readonly high: number;
  readonly low: number;
  readonly volume: number;
}

/** What the market looks like at the current position, for one symbol. */
export interface ReplayFrame extends SymbolView {
  readonly symbol: string;
  readonly position: number;
  readonly time: number;
  readonly commands: number;
  readonly depth: Depth;
}

interface Checkpoint {
  readonly state: SessionState;
  readonly commands: number;
  readonly views: ReadonlyMap<string, SymbolView>;
}

export class Replayer {
  readonly totalSteps: number;
  /** Steps applied so far. */
  position = 0;
  /** The furthest position reached; everything up to it has been verified. */
  frontier = 0;
  verdict: Verdict = { status: "pending" };

  private readonly entries: readonly LogEntry[];
  /** `starts[i]` is the position at which entry `i` begins; one extra element for the end. */
  private readonly starts: number[];
  private readonly checkpointEvery: number;
  private readonly checkpoints = new Map<number, Checkpoint>();
  private engine: SessionEngine<CountingExchange>;
  private views = new Map<string, SymbolView>();
  /** Index of the entry the next step belongs to. */
  private entryIndex = 0;

  constructor(
    private readonly log: ReplayLog,
    options: { readonly checkpointEvery?: number } = {},
  ) {
    if (log.head.seq !== log.entries.length) {
      throw new Error(
        `The log has ${String(log.entries.length)} entries but the server reported ${String(log.head.seq)}`,
      );
    }
    this.entries = log.entries;
    this.checkpointEvery = options.checkpointEvery ?? 500;
    this.starts = [0];
    for (const entry of log.entries) this.starts.push((this.starts.at(-1) ?? 0) + stepsIn(entry));
    this.totalSteps = this.starts.at(-1) ?? 0;

    this.engine = this.createEngine();
    for (const i of log.config.instruments) {
      const p = i.referencePrice;
      this.views.set(i.symbol, {
        candles: [],
        trades: [],
        open: p,
        last: p,
        high: p,
        low: p,
        volume: 0,
      });
    }
    this.saveCheckpoint();
    this.verifyHere();
  }

  /** Engine commands processed to reach the current position, bots included. */
  get commands(): number {
    return this.engine.exchange.commands;
  }

  /** The time of the current position: when its latest step happened. */
  get time(): number {
    return this.timeAt(this.position);
  }

  /** Session time at a position (the time of the step that led to it). */
  timeAt(position: number): number {
    if (this.entries.length === 0) return 0;
    if (position <= 0) {
      const first = this.entries[0];
      return first ? stepTime(first, 0) : 0;
    }
    const index = this.entryAt(position - 1);
    const entry = this.entries[index];
    return entry ? stepTime(entry, position - 1 - (this.starts[index] ?? 0)) : 0;
  }

  /** The 1-based log sequence fully applied at the current position. */
  get seq(): number {
    return this.position === this.totalSteps ? this.entries.length : this.entryAt(this.position);
  }

  /** Moves to `target` (clamped to the log), applying or rewinding as needed. */
  seek(target: number): void {
    const to = Math.max(0, Math.min(this.totalSteps, Math.floor(target)));
    if (to < this.position) this.restore(to - (to % this.checkpointEvery));
    while (this.position < to) this.step();
  }

  frame(symbol: string): ReplayFrame {
    const view = this.views.get(symbol);
    const depth = this.engine.exchange.depth(symbol, 15);
    if (!view || !depth) throw new Error(`No market named ${symbol}`);
    return {
      ...view,
      symbol,
      position: this.position,
      time: this.time,
      commands: this.commands,
      depth,
    };
  }

  stateHash(): string {
    return this.engine.exchange.stateHash();
  }

  // Internals --------------------------------------------------------------

  private createEngine(state?: SessionState): SessionEngine<CountingExchange> {
    return new SessionEngine(this.log.config, {
      createExchange: (markets) => new CountingExchange(markets),
      ...(state ? { state } : {}),
    });
  }

  /** Index of the entry that contains step number `step` (0-based). */
  private entryAt(step: number): number {
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((this.starts[mid] ?? 0) <= step) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private step(): void {
    while ((this.starts[this.entryIndex + 1] ?? Infinity) <= this.position) this.entryIndex += 1;
    const entry = this.entries[this.entryIndex];
    if (!entry) return;
    const offset = this.position - (this.starts[this.entryIndex] ?? 0);
    const { events, at } = this.engine.applyStep(entry, offset);
    this.fold(events, at);
    this.position += 1;

    if (this.position > this.frontier) {
      this.frontier = this.position;
      if (this.position % this.checkpointEvery === 0) this.saveCheckpoint();
      this.verifyHere();
    }
  }

  /**
   * Compares hashes at the current position, if the server recorded one here:
   * the hash an entry was applied to, or the final hash at the end of the log.
   */
  private verifyHere(): void {
    if (this.verdict.status !== "pending") return;
    const atEnd = this.position === this.totalSteps;
    // The entry that begins exactly here, if the position is on an entry boundary.
    const next =
      this.starts[this.entryIndex] === this.position ? this.entryIndex : this.entryIndex + 1;
    if (!atEnd && this.starts[next] !== this.position) return; // in the middle of an entry
    const index = atEnd ? this.entries.length : next;

    const expected = atEnd ? this.log.head.stateHash : this.entries[index]?.h;
    if (expected !== undefined) {
      const actual = this.stateHash();
      if (actual !== expected) {
        this.verdict = { status: "diverged", seq: index, expected, actual };
        return;
      }
    }
    if (atEnd) {
      this.verdict = {
        status: "verified",
        seq: this.entries.length,
        stateHash: this.log.head.stateHash,
      };
    }
  }

  private saveCheckpoint(): void {
    this.checkpoints.set(this.position, {
      state: this.engine.serialize(),
      commands: this.commands,
      views: new Map(this.views),
    });
  }

  private restore(position: number): void {
    const checkpoint = this.checkpoints.get(position);
    if (!checkpoint) throw new Error(`No checkpoint at ${String(position)}`);
    this.engine = this.createEngine(checkpoint.state);
    this.engine.exchange.commands = checkpoint.commands;
    this.views = new Map(checkpoint.views);
    this.position = position;
    this.entryIndex = position >= this.totalSteps ? this.entries.length : this.entryAt(position);
  }

  /** Folds trades into candles and the tape. Stored values are replaced, never mutated. */
  private fold(events: readonly EngineEvent[], at: number): void {
    for (const event of events) {
      if (event.type !== "trade") continue;
      const view = this.views.get(event.symbol);
      if (!view) continue;
      const price: number = event.price;
      const bucket = at - (at % CANDLE_MS);
      const current = view.candles.at(-1);
      const candles =
        current?.time === bucket
          ? [
              ...view.candles.slice(0, -1),
              {
                time: bucket,
                open: current.open,
                high: Math.max(current.high, price),
                low: Math.min(current.low, price),
                close: price,
                volume: current.volume + event.qty,
              },
            ]
          : [
              ...view.candles,
              {
                time: bucket,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: event.qty,
              },
            ].slice(-MAX_CANDLES);
      const trade: ReplayTrade = {
        seq: event.seq,
        price,
        qty: event.qty,
        aggressor: event.aggressor,
        time: at,
      };
      this.views.set(event.symbol, {
        candles,
        trades: [trade, ...view.trades].slice(0, MAX_TRADES),
        open: view.open,
        last: price,
        high: Math.max(view.high, price),
        low: Math.min(view.low, price),
        volume: view.volume + event.qty,
      });
    }
  }
}
