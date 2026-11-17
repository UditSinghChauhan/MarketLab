/**
 * A trading session as a pure function of its inputs.
 *
 * A session is one seed plus an ordered log of entries: a guest opened an
 * account, a guest sent a command, the simulated market advanced N ticks.
 * `SessionEngine` turns those inputs into an exchange. The server runs it to
 * serve the market and to rebuild after a restart; the browser's replay runs
 * the same class over the same log and must arrive at the same state hash.
 *
 * Everything that shapes the simulated market (the bot accounts, how the
 * simulators are seeded and tuned) is defined here, so there is exactly one
 * definition of "what this seed and this log mean".
 */

import type { Command, EngineEvent } from "./events.js";
import { Exchange, type ExchangeState, type MarketConfig } from "./exchange.js";
import { paise } from "./money.js";
import { MarketSimulator, type SimulatorState } from "./simulator.js";

/** Fields every entry carries. */
interface EntryBase {
  /** When it happened, epoch milliseconds. Dates trades and candles; never read by the engine. */
  readonly at: number;
  /**
   * `Exchange.stateHash()` of the state this entry was applied to. A replay
   * compares its own hash at the same point, which pins a divergence to one
   * entry. Absent on entries written before hashes were recorded.
   */
  readonly h?: string;
}

export type LogEntry =
  | (EntryBase & { readonly kind: "open"; readonly accountId: string })
  /** The market advanced `count` ticks, evenly spaced between `from` and `at`. */
  | (EntryBase & { readonly kind: "ticks"; readonly count: number; readonly from: number })
  | (EntryBase & { readonly kind: "command"; readonly command: Command });

export interface SessionInstrument extends MarketConfig {
  /** Fair-value move per tick, in ticks. */
  readonly volatilityTicks: number;
  readonly levelGapTicks: number;
  readonly levelSize: number;
}

export interface SessionConfig {
  readonly seed: number;
  readonly instruments: readonly SessionInstrument[];
  /** Cash a guest account opens with, in paise. */
  readonly guestCash: number;
}

export interface SessionState {
  readonly exchange: ExchangeState;
  readonly simulators: readonly SimulatorState[];
}

export const MAKER_PREFIX = "mm:";
export const FLOW_IDS = ["flow:1", "flow:2", "flow:3", "flow:4", "flow:5", "flow:6"] as const;

/** An exchange that counts the commands it has processed. */
export class CountingExchange extends Exchange {
  commands = 0;

  override submit(command: Command): EngineEvent[] {
    this.commands += 1;
    return super.submit(command);
  }
}

/** How many single steps an entry is: one per tick, one for anything else. */
export const stepsIn = (entry: LogEntry): number => (entry.kind === "ticks" ? entry.count : 1);

/** The time of step `offset` within an entry. Ticks are spread evenly from `from` to `at`. */
export function stepTime(entry: LogEntry, offset: number): number {
  if (entry.kind !== "ticks" || entry.count === 1) return entry.at;
  return Math.round(entry.from + ((entry.at - entry.from) * offset) / (entry.count - 1));
}

export class SessionEngine<E extends Exchange = Exchange> {
  readonly exchange: E;
  private readonly simulators: MarketSimulator[];

  constructor(
    private readonly config: SessionConfig,
    options: {
      /** Supplies the exchange, so a host can use an instrumented subclass. */
      readonly createExchange?: (markets: readonly MarketConfig[]) => E;
      /** Start from a serialised state instead of an empty market. */
      readonly state?: SessionState;
    } = {},
  ) {
    const create = options.createExchange ?? ((markets) => new Exchange(markets) as E);
    this.exchange = create(config.instruments);

    if (options.state) {
      this.exchange.load(options.state.exchange);
    } else {
      // Bot accounts come from configuration; they are never logged.
      for (const i of config.instruments) {
        this.exchange.accounts.open(`${MAKER_PREFIX}${i.symbol}`, paise(config.guestCash * 1_000), {
          [i.symbol]: 10_000_000,
        });
      }
      const holdings = Object.fromEntries(config.instruments.map((i) => [i.symbol, 50_000]));
      for (const id of FLOW_IDS) {
        this.exchange.accounts.open(id, paise(config.guestCash * 100), holdings);
      }
    }

    this.simulators = config.instruments.map(
      (i, index) =>
        new MarketSimulator(this.exchange, {
          symbol: i.symbol,
          seed: (config.seed + index * 7_919) >>> 0,
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
    if (options.state) {
      const saved = options.state.simulators;
      if (saved.length !== this.simulators.length) throw new Error("Snapshot simulators differ");
      this.simulators.forEach((simulator, index) => {
        const state = saved[index];
        if (state) simulator.load(state);
      });
    }
  }

  /** Advances every simulated market one tick. */
  tick(): EngineEvent[] {
    return this.simulators.flatMap((simulator) => simulator.step());
  }

  openGuest(accountId: string): void {
    this.exchange.accounts.open(accountId, paise(this.config.guestCash));
  }

  /** Applies one step of an entry (see `stepsIn`) and returns what it caused, and when. */
  applyStep(entry: LogEntry, offset: number): { events: EngineEvent[]; at: number } {
    const at = stepTime(entry, offset);
    switch (entry.kind) {
      case "open":
        this.openGuest(entry.accountId);
        return { events: [], at };
      case "ticks":
        return { events: this.tick(), at };
      case "command":
        return { events: this.exchange.submit(entry.command), at };
    }
  }

  /** Applies a whole entry, reporting each step's events with their time. */
  apply(entry: LogEntry, emit: (events: EngineEvent[], at: number) => void): void {
    const steps = stepsIn(entry);
    for (let offset = 0; offset < steps; offset++) {
      const { events, at } = this.applyStep(entry, offset);
      emit(events, at);
    }
  }

  serialize(): SessionState {
    return {
      exchange: this.exchange.serialize(),
      simulators: this.simulators.map((simulator) => simulator.serialize()),
    };
  }
}
