/**
 * Seeded market simulation: bots that keep the order book full and moving.
 *
 * - A market maker quotes several price levels on both sides of a "fair value"
 *   and re-quotes every step.
 * - Fair value follows a random walk measured in ticks.
 * - Noise traders send small market orders on random sides.
 *
 * All randomness comes from one seeded generator, and the bots act only
 * through `Exchange.submit`, the same entry point as a human trader. The same
 * seed therefore always produces the same market.
 */

import type { EngineEvent } from "./events.js";
import type { Exchange } from "./exchange.js";
import { paise } from "./money.js";
import { quantity } from "./price.js";

/** mulberry32: a small, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatorConfig {
  readonly symbol: string;
  readonly seed: number;
  readonly makerId: string;
  readonly takerIds: readonly string[];
  /** Price levels quoted on each side. Default 5. */
  readonly levels?: number;
  /** Base shares per quoted level. Default 50. */
  readonly levelSize?: number;
  /** Ticks between fair value and the best quote on each side. Default 1. */
  readonly halfSpreadTicks?: number;
  /** Largest fair-value move per step, in ticks. Default 2. */
  readonly volatilityTicks?: number;
  /** Chance each taker trades on a step. Default 0.3. */
  readonly takerProbability?: number;
  /** Largest market order a taker sends. Default 40. */
  readonly maxTakerQty?: number;
}

export class MarketSimulator {
  private readonly random: () => number;
  private readonly tick: number;
  private fairTicks: number;
  private readonly cfg: Required<SimulatorConfig>;

  constructor(
    private readonly exchange: Exchange,
    config: SimulatorConfig,
  ) {
    const market = exchange.market(config.symbol);
    if (!market) throw new Error(`Unknown market ${config.symbol}`);
    this.cfg = {
      levels: 5,
      levelSize: 50,
      halfSpreadTicks: 1,
      volatilityTicks: 2,
      takerProbability: 0.3,
      maxTakerQty: 40,
      ...config,
    };
    this.random = mulberry32(config.seed);
    this.tick = market.tickSize;
    this.fairTicks = market.referencePrice / market.tickSize;
  }

  /** Current fair value the maker quotes around. */
  fairValue(): number {
    return this.fairTicks * this.tick;
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /** Advances the market one step and returns every event it caused. */
  step(): EngineEvent[] {
    const { symbol, makerId, levels, levelSize, halfSpreadTicks, volatilityTicks } = this.cfg;
    const events: EngineEvent[] = [];
    const submit = (...args: Parameters<Exchange["submit"]>): void => {
      events.push(...this.exchange.submit(...args));
    };

    // 1. Fair value drifts. It never falls below the quoted depth, so bids stay positive.
    const floor = halfSpreadTicks + levels + 1;
    this.fairTicks = Math.max(floor, this.fairTicks + this.int(-volatilityTicks, volatilityTicks));

    // 2. The maker pulls its old quotes and posts fresh ones around fair value.
    for (const open of this.exchange.openOrders(makerId)) {
      if (open.order.symbol === symbol) {
        submit({ kind: "cancel", accountId: makerId, orderId: open.order.id });
      }
    }
    for (let level = 0; level < levels; level++) {
      const size = quantity(levelSize + this.int(0, levelSize));
      const offset = halfSpreadTicks + level;
      const bid = paise((this.fairTicks - offset) * this.tick);
      const ask = paise((this.fairTicks + offset) * this.tick);
      if (this.exchange.accounts.availableCash(makerId) >= bid * size) {
        submit({
          kind: "place",
          accountId: makerId,
          symbol,
          side: "buy",
          type: "limit",
          qty: size,
          limitPrice: bid,
        });
      }
      if (this.exchange.accounts.availableShares(makerId, symbol) >= size) {
        submit({
          kind: "place",
          accountId: makerId,
          symbol,
          side: "sell",
          type: "limit",
          qty: size,
          limitPrice: ask,
        });
      }
    }

    // 3. Noise traders hit the book with small market orders.
    for (const takerId of this.cfg.takerIds) {
      if (this.random() >= this.cfg.takerProbability) continue;
      const qty = quantity(this.int(1, this.cfg.maxTakerQty));
      const wantsToSell = this.random() < 0.5;
      const canSell = this.exchange.accounts.availableShares(takerId, symbol) >= qty;
      const side = wantsToSell && canSell ? "sell" : "buy";
      submit({ kind: "place", accountId: takerId, symbol, side, type: "market", qty });
    }

    return events;
  }
}
