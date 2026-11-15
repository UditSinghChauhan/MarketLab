/**
 * Read models built from the engine's event stream.
 *
 * The engine answers "what is true now" (balances, the book). Everything the
 * UI needs about history — prices, candles, the trade tape, cost basis, order
 * status and per-order traces — is derived here by folding events in order.
 * Because it is a pure fold over events, replaying the command log rebuilds it
 * exactly, with no tables of its own.
 */

import type {
  Candle,
  CommandTiming,
  EventView,
  OrderStatus,
  OrderTrace,
  OrderView,
  TradePrint,
} from "@marketlab/contracts";
import { parseRupees, type EngineEvent, type OrderId, type Paise } from "@marketlab/engine";

import type { InstrumentConfig } from "./instruments.js";
import { rupees, toEventView } from "./serialize.js";

export const CANDLE_MS = 15_000;
const MAX_CANDLES = 480; // two hours of 15-second candles
const MAX_TRADES = 120;
const MAX_ORDERS_PER_ACCOUNT = 200;

interface SymbolStats {
  open: number;
  last: number;
  high: number;
  low: number;
  volume: number;
  trades: number;
  tape: TradePrint[];
  candles: Candle[];
}

interface CostBasis {
  qty: number;
  /** Total paise paid for the shares currently held. */
  cost: number;
  realized: number;
}

interface TrackedOrder {
  accountId: string;
  view: {
    -readonly [K in keyof OrderView]: OrderView[K];
  };
  filledNotional: number;
  timing: CommandTiming | null;
  events: EventView[];
}

/** Every read model as plain data, in the order it was built. */
export interface MarketDataState {
  readonly symbols: readonly (readonly [string, SymbolStats])[];
  readonly humans: readonly string[];
  readonly orders: readonly TrackedOrder[];
  readonly ordersByAccount: readonly (readonly [string, readonly string[]])[];
  readonly basis: readonly (readonly [string, readonly (readonly [string, CostBasis])[]])[];
  readonly tradeCount: number;
}

export class MarketData {
  private readonly symbols = new Map<string, SymbolStats>();
  private readonly humans = new Set<string>();
  private readonly orders = new Map<string, TrackedOrder>();
  private readonly ordersByAccount = new Map<string, string[]>();
  private readonly basis = new Map<string, Map<string, CostBasis>>();
  private tradeCount = 0;

  constructor(instruments: readonly InstrumentConfig[]) {
    for (const i of instruments) {
      const p = i.referencePrice;
      this.symbols.set(i.symbol, {
        open: p,
        last: p,
        high: p,
        low: p,
        volume: 0,
        trades: 0,
        tape: [],
        candles: [],
      });
    }
  }

  /** The read models as they are now. The caller must serialise the result before the next event. */
  serialize(): MarketDataState {
    return {
      symbols: [...this.symbols],
      humans: [...this.humans],
      // Request timings are measurements, not state: a full replay cannot recover
      // them, so a snapshot does not carry them either and both paths agree.
      orders: [...this.orders.values()].map((order) => ({ ...order, timing: null })),
      ordersByAccount: [...this.ordersByAccount],
      basis: [...this.basis].map(([account, positions]) => [account, [...positions]] as const),
      tradeCount: this.tradeCount,
    };
  }

  /** Replaces the read models with a serialised state (already parsed from JSON, so not shared). */
  load(state: MarketDataState): void {
    for (const [symbol, stats] of state.symbols) {
      if (!this.symbols.has(symbol)) throw new Error(`Snapshot has unknown market ${symbol}`);
      this.symbols.set(symbol, stats);
    }
    for (const id of state.humans) this.humans.add(id);
    for (const order of state.orders) this.orders.set(order.view.id, order);
    for (const [account, ids] of state.ordersByAccount) {
      this.ordersByAccount.set(account, [...ids]);
    }
    for (const [account, positions] of state.basis) this.basis.set(account, new Map(positions));
    this.tradeCount = state.tradeCount;
  }

  /** Marks an account as a person, whose orders, costs and traces are tracked. */
  registerHuman(accountId: string): void {
    this.humans.add(accountId);
  }

  isHuman(accountId: string): boolean {
    return this.humans.has(accountId);
  }

  /**
   * Folds a batch of events produced at time `at`. Returns the trades it
   * recorded and the human accounts whose orders or balances changed.
   */
  ingest(
    events: readonly EngineEvent[],
    at: number,
  ): { trades: TradePrint[]; accounts: Set<string> } {
    const trades: TradePrint[] = [];
    const accounts = new Set<string>();

    for (const event of events) {
      switch (event.type) {
        case "order.accepted": {
          const { order } = event;
          if (!this.humans.has(order.accountId)) break;
          this.track({
            accountId: order.accountId,
            view: {
              id: order.id,
              symbol: order.symbol,
              side: order.side,
              type: order.type,
              qty: order.qty,
              filled: 0,
              remaining: order.qty,
              price: order.type === "limit" ? rupees(order.limitPrice) : null,
              stopPrice: order.type === "stop" ? rupees(order.stopPrice) : null,
              avgFillPrice: null,
              status: order.type === "stop" ? "pending_stop" : "resting",
              reason: null,
              createdAt: at,
              updatedAt: at,
            },
            filledNotional: 0,
            timing: null,
            events: [],
          });
          accounts.add(order.accountId);
          break;
        }
        case "trade": {
          const print = this.recordTrade(event, at);
          trades.push(print);
          for (const [orderId, accountId, side] of [
            [event.buyOrderId, event.buyAccountId, "buy"],
            [event.sellOrderId, event.sellAccountId, "sell"],
          ] as const) {
            if (!this.humans.has(accountId)) continue;
            accounts.add(accountId);
            this.applyFill(accountId, event.symbol, side, event.price, event.qty);
            const order = this.orders.get(orderId);
            if (order) {
              order.view.filled += event.qty;
              order.view.remaining -= event.qty;
              order.filledNotional += event.price * event.qty;
              order.view.avgFillPrice = rupees(
                Math.round(order.filledNotional / order.view.filled),
              );
              order.view.updatedAt = at;
            }
          }
          break;
        }
        case "order.rested":
          this.updateStatus(event.orderId, "resting", null, at, accounts);
          break;
        case "order.filled":
          this.updateStatus(event.orderId, "filled", null, at, accounts);
          break;
        case "order.cancelled":
          this.updateStatus(event.orderId, "cancelled", event.reason, at, accounts);
          break;
        case "stop.triggered":
          this.updateStatus(event.orderId, "resting", null, at, accounts);
          break;
        case "order.rejected":
          break;
      }
      this.appendTrace(event, at);
    }
    return { trades, accounts };
  }

  /** Attaches the request timing to the order a command created. */
  setTiming(orderId: string, timing: CommandTiming): void {
    const order = this.orders.get(orderId);
    if (order) order.timing = timing;
  }

  // Event bookkeeping -----------------------------------------------------

  private track(order: TrackedOrder): void {
    const { accountId } = order;
    this.orders.set(order.view.id, order);
    const list = this.ordersByAccount.get(accountId) ?? [];
    list.push(order.view.id);
    if (list.length > MAX_ORDERS_PER_ACCOUNT) {
      const dropped = list.shift();
      if (dropped !== undefined) this.orders.delete(dropped);
    }
    this.ordersByAccount.set(accountId, list);
  }

  private updateStatus(
    orderId: OrderId,
    status: OrderStatus,
    reason: string | null,
    at: number,
    accounts: Set<string>,
  ): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    order.view.status = status;
    if (status === "cancelled") order.view.remaining = 0;
    if (reason !== null) order.view.reason = reason;
    order.view.updatedAt = at;
    accounts.add(order.accountId);
  }

  private appendTrace(event: EngineEvent, at: number): void {
    const ids: string[] = [];
    if (event.type === "order.accepted") ids.push(event.order.id);
    else if (event.type === "trade") ids.push(event.buyOrderId, event.sellOrderId);
    else if (event.type !== "order.rejected") ids.push(event.orderId);
    for (const id of ids) this.orders.get(id)?.events.push(toEventView(event, at));
  }

  private recordTrade(event: Extract<EngineEvent, { type: "trade" }>, at: number): TradePrint {
    const stats = this.stats(event.symbol);
    const price: number = event.price;
    stats.last = price;
    stats.high = Math.max(stats.high, price);
    stats.low = Math.min(stats.low, price);
    stats.volume += event.qty;
    stats.trades += 1;
    this.tradeCount += 1;

    const print: TradePrint = {
      seq: event.seq,
      symbol: event.symbol,
      price: rupees(price),
      qty: event.qty,
      aggressor: event.aggressor,
      time: at,
    };
    stats.tape.push(print);
    if (stats.tape.length > MAX_TRADES) stats.tape.shift();

    const bucket = at - (at % CANDLE_MS);
    const current = stats.candles.at(-1);
    if (current?.time === bucket) {
      stats.candles[stats.candles.length - 1] = {
        time: bucket,
        open: current.open,
        high: rupees(Math.max(price, parseRupees(current.high))),
        low: rupees(Math.min(price, parseRupees(current.low))),
        close: rupees(price),
        volume: current.volume + event.qty,
      };
    } else {
      const p = rupees(price);
      stats.candles.push({ time: bucket, open: p, high: p, low: p, close: p, volume: event.qty });
      if (stats.candles.length > MAX_CANDLES) stats.candles.shift();
    }
    return print;
  }

  /** Average-cost accounting: buys add to cost; sells realise P&L against the average. */
  private applyFill(
    accountId: string,
    symbol: string,
    side: "buy" | "sell",
    price: Paise,
    qty: number,
  ): void {
    let positions = this.basis.get(accountId);
    if (!positions) {
      positions = new Map();
      this.basis.set(accountId, positions);
    }
    const b = positions.get(symbol) ?? { qty: 0, cost: 0, realized: 0 };
    if (side === "buy") {
      b.qty += qty;
      b.cost += price * qty;
    } else {
      const costOut = b.qty === 0 ? 0 : Math.round((b.cost * qty) / b.qty);
      b.realized += price * qty - costOut;
      b.cost -= costOut;
      b.qty -= qty;
    }
    positions.set(symbol, b);
  }

  private stats(symbol: string): SymbolStats {
    const stats = this.symbols.get(symbol);
    if (!stats) throw new Error(`Unknown symbol ${symbol}`);
    return stats;
  }

  // Reads ------------------------------------------------------------------

  symbol(symbol: string): Readonly<SymbolStats> | undefined {
    return this.symbols.get(symbol);
  }

  tape(symbol: string, limit = 50): TradePrint[] {
    return (this.symbols.get(symbol)?.tape ?? []).slice(-limit).reverse();
  }

  candles(symbol: string): Candle[] {
    return [...(this.symbols.get(symbol)?.candles ?? [])];
  }

  lastCandle(symbol: string): Candle | undefined {
    return this.symbols.get(symbol)?.candles.at(-1);
  }

  costBasis(accountId: string, symbol: string): Readonly<CostBasis> {
    return this.basis.get(accountId)?.get(symbol) ?? { qty: 0, cost: 0, realized: 0 };
  }

  /** The account's orders, newest first. */
  ordersOf(accountId: string): OrderView[] {
    const ids = this.ordersByAccount.get(accountId) ?? [];
    return ids
      .map((id) => this.orders.get(id)?.view)
      .filter((v): v is NonNullable<typeof v> => v !== undefined)
      .reverse()
      .map((v) => ({ ...v }));
  }

  symbolOf(orderId: string): string | undefined {
    return this.orders.get(orderId)?.view.symbol;
  }

  isOrderOf(orderId: string, accountId: string): boolean {
    return this.orders.get(orderId)?.accountId === accountId;
  }

  trace(orderId: string): OrderTrace | undefined {
    const order = this.orders.get(orderId);
    if (!order) return undefined;
    const { view } = order;
    return {
      orderId: view.id,
      symbol: view.symbol,
      side: view.side,
      type: view.type,
      qty: view.qty,
      timing: order.timing,
      events: [...order.events],
    };
  }

  totalTrades(): number {
    return this.tradeCount;
  }
}
