/**
 * Limit order book for one symbol.
 *
 * Structure
 * - Each side is an array of price levels kept sorted from worst to best, so
 *   the best level is always the last element: reading it is O(1), and
 *   removing it after it empties is an O(1) `pop()`.
 * - Each level is a FIFO queue. Orders at the same price fill in arrival order
 *   (time priority).
 * - An index from order id to its level makes cancel O(1) to find. Cancelled
 *   orders are removed lazily: their remaining quantity drops to zero at once
 *   (so level totals stay exact), and the queue skips them when they reach
 *   the front.
 *
 * Inserting a new price level is a binary search plus an array splice, O(n) in
 * the number of levels. Books here hold tens of levels, where a contiguous
 * array beats a balanced tree in practice; see docs/adr/0003-matching-engine.md.
 *
 * The book only stores and orders resting liquidity. It knows nothing about
 * accounts or money rules; the Exchange decides what may rest and what trades.
 */

import type { Paise } from "./money.js";
import type { OrderId, Side } from "./order.js";

export interface RestingOrder {
  readonly id: OrderId;
  readonly accountId: string;
  readonly side: Side;
  readonly price: Paise;
  /** Arrival sequence; lower means earlier. */
  readonly seq: number;
  remaining: number;
}

export interface DepthLevel {
  readonly price: Paise;
  readonly qty: number;
  readonly orders: number;
}

export interface Depth {
  readonly bids: readonly DepthLevel[];
  readonly asks: readonly DepthLevel[];
}

class Level {
  private queue: RestingOrder[] = [];
  private head = 0;
  totalQty = 0;
  liveOrders = 0;

  constructor(readonly price: Paise) {}

  push(order: RestingOrder): void {
    this.queue.push(order);
    this.totalQty += order.remaining;
    this.liveOrders += 1;
  }

  /** Oldest order that still has quantity, skipping lazily cancelled ones. */
  front(): RestingOrder | undefined {
    while (this.head < this.queue.length && this.queue[this.head]?.remaining === 0) {
      this.head += 1;
    }
    // Compact occasionally so skipped entries do not accumulate.
    if (this.head > 32 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return this.queue[this.head];
  }

  reduce(order: RestingOrder, qty: number): void {
    order.remaining -= qty;
    this.totalQty -= qty;
    if (order.remaining === 0) this.liveOrders -= 1;
  }

  /** Live orders in arrival order. Used for auditing and tests. */
  live(): RestingOrder[] {
    return this.queue.slice(this.head).filter((o) => o.remaining > 0);
  }
}

class BookSide {
  /** Sorted worst → best; the best level is last. */
  private readonly levels: Level[] = [];
  private readonly byPrice = new Map<number, Level>();

  constructor(private readonly side: Side) {}

  /** True if `a` is a better price than `b` for this side. */
  better(a: number, b: number): boolean {
    return this.side === "buy" ? a > b : a < b;
  }

  best(): Level | undefined {
    return this.levels[this.levels.length - 1];
  }

  levelFor(price: Paise): Level {
    const existing = this.byPrice.get(price);
    if (existing) return existing;

    const level = new Level(price);
    // First index whose price is better than the new one; insert before it.
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midLevel = this.levels[mid];
      if (midLevel && this.better(midLevel.price, price)) hi = mid;
      else lo = mid + 1;
    }
    this.levels.splice(lo, 0, level);
    this.byPrice.set(price, level);
    return level;
  }

  removeIfEmpty(level: Level): void {
    if (level.liveOrders > 0) return;
    this.byPrice.delete(level.price);
    if (this.levels[this.levels.length - 1] === level) {
      this.levels.pop();
    } else {
      this.levels.splice(this.levels.indexOf(level), 1);
    }
  }

  /** Levels best → worst. */
  bestFirst(): Level[] {
    return [...this.levels].reverse();
  }
}

export class OrderBook {
  private readonly bids = new BookSide("buy");
  private readonly asks = new BookSide("sell");
  private readonly index = new Map<OrderId, { order: RestingOrder; level: Level }>();

  constructor(readonly symbol: string) {}

  private sideOf(side: Side): BookSide {
    return side === "buy" ? this.bids : this.asks;
  }

  add(order: RestingOrder): void {
    if (this.index.has(order.id)) throw new Error(`Order ${order.id} is already in the book`);
    const level = this.sideOf(order.side).levelFor(order.price);
    level.push(order);
    this.index.set(order.id, { order, level });
  }

  /** Best resting order on `side`, i.e. the next order to trade there. */
  bestOrder(side: Side): RestingOrder | undefined {
    const bookSide = this.sideOf(side);
    for (;;) {
      const level = bookSide.best();
      if (!level) return undefined;
      const order = level.front();
      if (order) return order;
      bookSide.removeIfEmpty(level);
    }
  }

  bestPrice(side: Side): Paise | undefined {
    return this.sideOf(side).best()?.price;
  }

  get(id: OrderId): RestingOrder | undefined {
    return this.index.get(id)?.order;
  }

  /** Reduces a resting order by `qty` (a fill or a cancel); removes it at zero. */
  reduce(id: OrderId, qty: number): void {
    const entry = this.index.get(id);
    if (!entry) throw new Error(`Order ${id} is not in the book`);
    const { order, level } = entry;
    if (qty <= 0 || qty > order.remaining) {
      throw new Error(`Cannot reduce ${id} by ${qty}; ${order.remaining} remaining`);
    }
    level.reduce(order, qty);
    if (order.remaining === 0) {
      this.index.delete(id);
      this.sideOf(order.side).removeIfEmpty(level);
    }
  }

  /** Removes a resting order entirely; returns the quantity that was left. */
  remove(id: OrderId): number {
    const order = this.get(id);
    if (!order) return 0;
    const left = order.remaining;
    this.reduce(id, left);
    return left;
  }

  depth(maxLevels = 10): Depth {
    const view = (side: BookSide): DepthLevel[] =>
      side
        .bestFirst()
        .slice(0, maxLevels)
        .map((l) => ({ price: l.price, qty: l.totalQty, orders: l.liveOrders }));
    return { bids: view(this.bids), asks: view(this.asks) };
  }

  /** Every live resting order, best price first, then arrival order. */
  restingOrders(side: Side): RestingOrder[] {
    return this.sideOf(side)
      .bestFirst()
      .flatMap((l) => l.live());
  }

  /** Structural problems, if any. Empty means the book is consistent. */
  audit(): string[] {
    const problems: string[] = [];
    const bid = this.bestPrice("buy");
    const ask = this.bestPrice("sell");
    if (bid !== undefined && ask !== undefined && bid >= ask) {
      problems.push(`${this.symbol}: book is crossed (bid ${bid} >= ask ${ask})`);
    }
    for (const side of ["buy", "sell"] as const) {
      let previous: number | undefined;
      for (const level of this.sideOf(side).bestFirst()) {
        const live = level.live();
        const sum = live.reduce((total, o) => total + o.remaining, 0);
        if (live.length === 0) problems.push(`${this.symbol}: empty ${side} level ${level.price}`);
        if (sum !== level.totalQty || live.length !== level.liveOrders) {
          problems.push(`${this.symbol}: ${side} level ${level.price} totals out of sync`);
        }
        if (previous !== undefined && !this.sideOf(side).better(previous, level.price)) {
          problems.push(`${this.symbol}: ${side} levels out of order at ${level.price}`);
        }
        for (let i = 1; i < live.length; i++) {
          const a = live[i - 1];
          const b = live[i];
          if (a && b && a.seq >= b.seq) {
            problems.push(`${this.symbol}: time priority broken at ${level.price}`);
          }
        }
        previous = level.price;
      }
    }
    return problems;
  }
}
