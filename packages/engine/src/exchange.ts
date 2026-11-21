/**
 * The exchange: validates commands, reserves balances, matches orders and
 * settles trades, emitting an event for every state change.
 *
 * Design (see docs/adr/0003-matching-engine.md)
 * - Single-threaded and in-memory. Commands are processed one at a time, to
 *   completion, so there are no locks and no partial states between commands.
 * - Deterministic. Order ids and sequence numbers come from one counter; no
 *   clocks or randomness are read here. The same commands always produce the
 *   same events, which makes every bug reproducible and allows replay.
 * - Price-time priority. Best price first; at the same price, earliest first.
 *   Trades execute at the resting (maker) order's price.
 * - Self-trade prevention: if an incoming order would hit the same account's
 *   resting order, the resting order is cancelled and matching continues.
 */

import { Accounts, type AccountsState } from "./accounts.js";
import { OrderBook, type Depth } from "./book.js";
import type {
  CancelCommand,
  CancelReason,
  Command,
  EngineEvent,
  PlaceCommand,
  RejectReason,
  UnsequencedEvent,
} from "./events.js";
import { StateHasher } from "./hash.js";
import { MoneyError, notional, paise, subtract, type Paise } from "./money.js";
import { oppositeSide, type Order, type OrderId } from "./order.js";
import { isOnTick, type Quantity } from "./price.js";

export interface MarketConfig {
  readonly symbol: string;
  readonly tickSize: Paise;
  /** Starting last-traded price, used by stop triggers until the first trade. */
  readonly referencePrice: Paise;
}

export type OrderStatus = "resting" | "pending_stop";

export interface OpenOrder {
  readonly order: Order;
  readonly remaining: number;
  readonly status: OrderStatus;
}

/**
 * The whole engine state as plain JSON-compatible data: enough to rebuild an
 * identical exchange with `load`. Orders are listed in arrival order.
 */
export interface ExchangeState {
  readonly seq: number;
  readonly accounts: AccountsState;
  readonly markets: readonly {
    readonly symbol: string;
    readonly lastPrice: number;
    /** Untriggered stops, in arrival order. */
    readonly stops: readonly OrderId[];
  }[];
  readonly orders: readonly OpenOrder[];
  /**
   * Remembered client order ids, per account, oldest first. Absent when there
   * are none (and in snapshots taken before client order ids existed).
   */
  readonly clientOrders?: readonly (readonly [string, readonly ClientOrder[]])[];
}

/** How many client order ids the exchange remembers per account; older ones are forgotten. */
export const CLIENT_ORDER_IDS_PER_ACCOUNT = 500;

/** What became of a place command that carried a client order id. */
export interface ClientOrder {
  readonly clientOrderId: string;
  /** The command's details (`orderDetails`), to tell a retry from a reuse of the id. */
  readonly details: string;
  /** The order it created, or null if the exchange rejected it. */
  readonly orderId: OrderId | null;
  readonly rejectReason: RejectReason | null;
}

/** A place command's details, without its account or client order id. */
export function orderDetails(command: PlaceCommand): string {
  const price =
    command.type === "limit" ? command.limitPrice : command.type === "stop" ? command.stopPrice : 0;
  return `${command.symbol} ${command.side} ${command.type} ${String(command.qty)} ${String(price)}`;
}

interface OrderRecord {
  readonly order: Order;
  remaining: number;
  status: OrderStatus | "working";
}

interface MarketState {
  readonly config: MarketConfig;
  readonly book: OrderBook;
  lastPrice: Paise;
  /** Untriggered stop orders in arrival order. */
  stops: OrderRecord[];
}

export class Exchange {
  readonly accounts = new Accounts();
  private readonly markets = new Map<string, MarketState>();
  private readonly orders = new Map<OrderId, OrderRecord>();
  /** Per account, client order id to outcome, oldest first (insertion order). */
  private readonly clientOrders = new Map<string, Map<string, ClientOrder>>();
  /** Each account's part of the state hash, cached until that account's ids change. */
  private readonly clientOrderDigests = new Map<string, string>();
  private seq = 0;
  private out: EngineEvent[] = [];

  constructor(markets: readonly MarketConfig[]) {
    for (const config of markets) {
      if (this.markets.has(config.symbol)) throw new Error(`Duplicate market ${config.symbol}`);
      if (config.tickSize <= 0 || !isOnTick(config.referencePrice, config.tickSize)) {
        throw new MoneyError(`${config.symbol}: reference price must sit on a positive tick`);
      }
      this.markets.set(config.symbol, {
        config,
        book: new OrderBook(config.symbol),
        lastPrice: config.referencePrice,
        stops: [],
      });
    }
  }

  /** Processes one command to completion and returns the events it caused. */
  submit(command: Command): EngineEvent[] {
    this.out = [];
    if (command.kind === "cancel") this.cancel(command);
    else this.place(command);
    const events = this.out;
    this.out = [];
    return events;
  }

  // Reads ----------------------------------------------------------------

  symbols(): string[] {
    return [...this.markets.keys()];
  }

  market(symbol: string): MarketConfig | undefined {
    return this.markets.get(symbol)?.config;
  }

  lastPrice(symbol: string): Paise | undefined {
    return this.markets.get(symbol)?.lastPrice;
  }

  depth(symbol: string, maxLevels?: number): Depth | undefined {
    return this.markets.get(symbol)?.book.depth(maxLevels);
  }

  /** Open orders for an account, oldest first. */
  openOrders(accountId: string): OpenOrder[] {
    const result: OpenOrder[] = [];
    for (const record of this.orders.values()) {
      if (record.order.accountId !== accountId || record.status === "working") continue;
      result.push({ order: record.order, remaining: record.remaining, status: record.status });
    }
    return result.sort((a, b) => a.order.seq - b.order.seq);
  }

  /** What became of the account's order with this client order id, if it is remembered. */
  clientOrder(accountId: string, clientOrderId: string): ClientOrder | undefined {
    return this.clientOrders.get(accountId)?.get(clientOrderId);
  }

  // Snapshots and hashing -------------------------------------------------

  /** Captures the state between commands. `load` on a fresh exchange restores it exactly. */
  serialize(): ExchangeState {
    const clientOrders = [...this.clientOrders].map(
      ([accountId, seen]) => [accountId, [...seen.values()]] as const,
    );
    return {
      ...(clientOrders.length > 0 ? { clientOrders } : {}),
      seq: this.seq,
      accounts: this.accounts.serialize(),
      markets: [...this.markets.values()].map((m) => ({
        symbol: m.config.symbol,
        lastPrice: m.lastPrice,
        stops: m.stops.map((r) => r.order.id),
      })),
      orders: [...this.orders.values()]
        .filter((r): r is OrderRecord & { status: OrderStatus } => r.status !== "working")
        .sort((a, b) => a.order.seq - b.order.seq)
        .map((r) => ({ order: r.order, remaining: r.remaining, status: r.status })),
    };
  }

  /**
   * Restores a serialised state into this exchange, which must be new (same
   * markets, no accounts, no commands yet). Resting orders re-enter the book in
   * arrival order, which is exactly their time priority.
   */
  load(state: ExchangeState): void {
    if (this.seq !== 0 || this.orders.size > 0 || this.accounts.ids().length > 0) {
      throw new Error("An exchange can only be loaded before it has processed anything");
    }
    this.accounts.load(state.accounts);
    this.seq = state.seq;

    for (const { order, remaining, status } of state.orders) {
      const record: OrderRecord = { order, remaining, status };
      const market = this.marketOf(record);
      this.orders.set(order.id, record);
      if (status !== "resting") continue;
      if (order.type !== "limit") throw new Error(`${order.id}: only limit orders can rest`);
      market.book.add({
        id: order.id,
        accountId: order.accountId,
        side: order.side,
        price: order.limitPrice,
        seq: order.seq,
        remaining,
      });
    }

    if (state.markets.length !== this.markets.size) throw new Error("Snapshot markets differ");
    for (const saved of state.markets) {
      const market = this.markets.get(saved.symbol);
      if (!market) throw new Error(`Snapshot has unknown market ${saved.symbol}`);
      market.lastPrice = paise(saved.lastPrice);
      market.stops = saved.stops.map((id) => this.recordOf(id));
    }

    for (const [accountId, remembered] of state.clientOrders ?? []) {
      this.clientOrders.set(accountId, new Map(remembered.map((c) => [c.clientOrderId, c])));
    }
  }

  /**
   * A hash of everything that decides what the engine does next: the sequence
   * counter, every book (each level and its queue order), pending stops, last
   * prices and all balances. Two exchanges with the same hash will produce the
   * same events for the same commands. See `StateHasher` for its guarantees.
   */
  stateHash(): string {
    const h = new StateHasher().int(this.seq);

    const symbols = [...this.markets.keys()].sort();
    for (const symbol of symbols) {
      const market = this.markets.get(symbol);
      if (!market) continue;
      h.str(symbol).int(market.lastPrice);
      for (const side of ["buy", "sell"] as const) {
        const levels = market.book.levels(side);
        h.int(levels.length);
        for (const level of levels) {
          h.int(level.price).int(level.orders.length);
          for (const order of level.orders)
            h.int(order.seq).str(order.accountId).int(order.remaining);
        }
      }
      h.int(market.stops.length);
      for (const { order, remaining } of market.stops) {
        h.int(order.seq).str(order.accountId).str(order.side).int(remaining);
        h.int(order.type === "stop" ? order.stopPrice : 0);
      }
    }

    const { accounts } = this.accounts.serialize();
    h.int(accounts.length);
    for (const account of accounts) {
      h.str(account.id).int(account.cash[0]).int(account.cash[1]).int(account.positions.length);
      for (const [symbol, available, reserved] of account.positions) {
        h.str(symbol).int(available).int(reserved);
      }
    }

    // Remembered client order ids decide how a retry is answered. Mixed in
    // only when there are any, so a state without them hashes exactly as it
    // did before they existed (logs written then still verify).
    const remembered = [...this.clientOrders.keys()].sort();
    if (remembered.length > 0) {
      h.int(remembered.length);
      for (const accountId of remembered) h.str(accountId).str(this.clientOrderDigest(accountId));
    }
    return h.digest();
  }

  /** One account's remembered ids and outcomes, in order, as a digest (cached). */
  private clientOrderDigest(accountId: string): string {
    const cached = this.clientOrderDigests.get(accountId);
    if (cached !== undefined) return cached;
    const h = new StateHasher();
    const seen = this.clientOrders.get(accountId) ?? new Map<string, ClientOrder>();
    h.int(seen.size);
    for (const c of seen.values()) {
      h.str(c.clientOrderId)
        .str(c.details)
        .str(c.orderId ?? "")
        .str(c.rejectReason ?? "");
    }
    const digest = h.digest();
    this.clientOrderDigests.set(accountId, digest);
    return digest;
  }

  /**
   * Remembers what became of a place command with a client order id. The
   * first outcome stands (the host never logs a second command with the same
   * id, so a replay never meets one); past the limit, the oldest is forgotten.
   */
  private remember(command: PlaceCommand, orderId: OrderId | null, reason: RejectReason | null) {
    const { accountId, clientOrderId } = command;
    if (clientOrderId === undefined || !this.accounts.has(accountId)) return;
    let seen = this.clientOrders.get(accountId);
    if (!seen) {
      seen = new Map();
      this.clientOrders.set(accountId, seen);
    }
    if (seen.has(clientOrderId)) return;
    seen.set(clientOrderId, {
      clientOrderId,
      details: orderDetails(command),
      orderId,
      rejectReason: reason,
    });
    if (seen.size > CLIENT_ORDER_IDS_PER_ACCOUNT) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    this.clientOrderDigests.delete(accountId);
  }

  // Commands -------------------------------------------------------------

  private emit(event: UnsequencedEvent): void {
    this.seq += 1;
    this.out.push({ ...event, seq: this.seq });
  }

  private reject(command: Command, reason: RejectReason): void {
    this.emit({ type: "order.rejected", reason, command });
  }

  /**
   * Validation and risk check. Returns why the order must be rejected, or the
   * market and the cash a limit buy must reserve.
   *
   * Sells reserve shares (stops included, so shares cannot be promised twice).
   * Limit buys reserve their worst-case cost. Market and stop buys reserve
   * nothing: their price is unknown until they execute, so affordability is
   * checked fill by fill instead.
   */
  private validate(
    command: PlaceCommand,
  ): { reason: RejectReason } | { market: MarketState; buyReserve: Paise | undefined } {
    const { accountId, symbol, side, qty } = command;
    if (!this.accounts.has(accountId)) return { reason: "unknown_account" };
    const market = this.markets.get(symbol);
    if (!market) return { reason: "unknown_symbol" };
    if (!Number.isSafeInteger(qty) || qty <= 0) return { reason: "invalid_quantity" };

    if (command.type !== "market") {
      const price = command.type === "limit" ? command.limitPrice : command.stopPrice;
      if (!Number.isSafeInteger(price) || price <= 0) return { reason: "invalid_price" };
      if (!isOnTick(price, market.config.tickSize)) return { reason: "off_tick" };
    }

    if (side === "sell") {
      const held = this.accounts.availableShares(accountId, symbol);
      return held < qty ? { reason: "insufficient_shares" } : { market, buyReserve: undefined };
    }
    if (command.type !== "limit") return { market, buyReserve: undefined };

    let buyReserve: Paise;
    try {
      buyReserve = notional(command.limitPrice, qty);
    } catch {
      return { reason: "insufficient_funds" }; // beyond any representable balance
    }
    return buyReserve > this.accounts.availableCash(accountId)
      ? { reason: "insufficient_funds" }
      : { market, buyReserve };
  }

  private place(command: PlaceCommand): void {
    const checked = this.validate(command);
    if ("reason" in checked) {
      this.remember(command, null, checked.reason);
      this.reject(command, checked.reason);
      return;
    }
    const { market, buyReserve } = checked;
    const { accountId, symbol, side, qty } = command;

    const seq = this.seq + 1; // the sequence number the accepted event receives
    const order = toOrder(command, `ord_${String(seq)}` as OrderId, seq);
    this.remember(command, order.id, null);
    this.emit({ type: "order.accepted", order });

    if (side === "sell") this.accounts.reserveShares(accountId, symbol, qty);
    if (buyReserve !== undefined) this.accounts.reserveCash(accountId, buyReserve);

    const record: OrderRecord = { order, remaining: qty, status: "working" };
    this.orders.set(order.id, record);

    if (order.type === "stop") {
      record.status = "pending_stop";
      market.stops.push(record);
    } else {
      this.execute(market, record);
    }
    this.triggerStops(market);
  }

  private cancel(command: CancelCommand): void {
    const record = this.orders.get(command.orderId);
    if (!record) {
      this.reject(command, "unknown_order");
      return;
    }
    if (record.order.accountId !== command.accountId) {
      this.reject(command, "not_owner");
      return;
    }

    const market = this.marketOf(record);
    if (record.status === "resting") market.book.remove(record.order.id);
    if (record.status === "pending_stop") market.stops = market.stops.filter((r) => r !== record);
    this.close(record, "user");
  }

  // Matching -------------------------------------------------------------

  private execute(market: MarketState, taker: OrderRecord): void {
    const { order } = taker;
    const limit = order.type === "limit" ? order.limitPrice : undefined;
    const contraSide = oppositeSide(order.side);

    while (taker.remaining > 0) {
      const maker = market.book.bestOrder(contraSide);
      if (!maker) break;
      if (
        limit !== undefined &&
        (order.side === "buy" ? maker.price > limit : maker.price < limit)
      ) {
        break;
      }

      if (maker.accountId === order.accountId) {
        const makerRecord = this.recordOf(maker.id);
        market.book.remove(maker.id);
        this.close(makerRecord, "self_trade");
        continue;
      }

      let qty = Math.min(taker.remaining, maker.remaining);
      if (order.side === "buy" && limit === undefined) {
        const affordable = Math.floor(this.accounts.availableCash(order.accountId) / maker.price);
        qty = Math.min(qty, affordable);
        if (qty === 0) {
          this.close(taker, "insufficient_funds");
          return;
        }
      }
      this.trade(market, taker, this.recordOf(maker.id), maker.price, qty);
    }

    if (taker.remaining === 0) {
      this.orders.delete(order.id);
      this.emit({ type: "order.filled", orderId: order.id });
    } else if (limit !== undefined) {
      market.book.add({
        id: order.id,
        accountId: order.accountId,
        side: order.side,
        price: limit,
        seq: order.seq,
        remaining: taker.remaining,
      });
      taker.status = "resting";
      this.emit({
        type: "order.rested",
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        price: limit,
        remaining: taker.remaining,
      });
    } else {
      this.close(taker, "no_liquidity");
    }
  }

  /** Executes `qty` at the maker's resting `price` and settles both accounts. */
  private trade(
    market: MarketState,
    taker: OrderRecord,
    maker: OrderRecord,
    price: Paise,
    qty: number,
  ): void {
    const symbol = market.config.symbol;
    const cost = notional(price, qty);
    const [buy, sell] = taker.order.side === "buy" ? [taker, maker] : [maker, taker];
    const buyer = buy.order.accountId;
    const seller = sell.order.accountId;

    // Buyer pays. A limit buy pays out of its reservation and gets back the
    // difference when it trades below its limit.
    if (buy.order.type === "limit") {
      const reserved = notional(buy.order.limitPrice, qty);
      this.accounts.debitReservedCash(buyer, reserved);
      this.accounts.creditCash(buyer, subtract(reserved, cost));
    } else {
      this.accounts.debitAvailableCash(buyer, cost);
    }
    this.accounts.creditShares(buyer, symbol, qty);

    // Seller delivers reserved shares and receives the cash.
    this.accounts.debitReservedShares(seller, symbol, qty);
    this.accounts.creditCash(seller, cost);

    market.book.reduce(maker.order.id, qty);
    maker.remaining -= qty;
    taker.remaining -= qty;
    market.lastPrice = price;

    this.emit({
      type: "trade",
      symbol,
      price,
      qty,
      buyOrderId: buy.order.id,
      sellOrderId: sell.order.id,
      buyAccountId: buyer,
      sellAccountId: seller,
      aggressor: taker.order.side,
    });

    if (maker.remaining === 0) {
      this.orders.delete(maker.order.id);
      this.emit({ type: "order.filled", orderId: maker.order.id });
    }
  }

  /**
   * Triggers stops whose price the last trade has reached, one at a time in
   * arrival order. A triggered stop executes as a market order and may move the
   * price far enough to trigger further stops, so the due set is recomputed after
   * each one. Each stop triggers at most once, so this terminates.
   */
  private triggerStops(market: MarketState): void {
    for (;;) {
      const last = market.lastPrice;
      const due = market.stops.find(
        (r) =>
          r.order.type === "stop" &&
          (r.order.side === "buy" ? last >= r.order.stopPrice : last <= r.order.stopPrice),
      );
      if (!due) return;
      market.stops = market.stops.filter((r) => r !== due);
      due.status = "working";
      this.emit({ type: "stop.triggered", orderId: due.order.id, lastPrice: last });
      this.execute(market, due);
    }
  }

  /** Ends an order early, releasing whatever its remaining quantity still reserves. */
  private close(record: OrderRecord, reason: CancelReason): void {
    const { order, remaining } = record;
    if (order.side === "sell") {
      this.accounts.releaseShares(order.accountId, order.symbol, remaining);
    } else if (order.type === "limit") {
      this.accounts.releaseCash(order.accountId, notional(order.limitPrice, remaining));
    }
    this.orders.delete(order.id);
    this.emit({ type: "order.cancelled", orderId: order.id, remaining, reason });
  }

  private recordOf(id: OrderId): OrderRecord {
    const record = this.orders.get(id);
    if (!record) throw new Error(`No record for resting order ${id}`);
    return record;
  }

  private marketOf(record: OrderRecord): MarketState {
    const market = this.markets.get(record.order.symbol);
    if (!market) throw new Error(`No market ${record.order.symbol}`);
    return market;
  }

  // Audit ----------------------------------------------------------------

  /**
   * Checks every invariant the engine promises and returns the violations.
   * Empty means consistent. Property tests call this after every command; the
   * API can expose it as a health check.
   */
  audit(): string[] {
    const problems = this.accounts.auditConservation();

    const expectedCash = new Map<string, number>();
    const expectedShares = new Map<string, Map<string, number>>();
    for (const record of this.orders.values()) {
      const { order } = record;
      if (record.status === "working") problems.push(`${order.id}: left in working state`);
      if (order.side === "sell") {
        const shares = expectedShares.get(order.accountId) ?? new Map<string, number>();
        shares.set(order.symbol, (shares.get(order.symbol) ?? 0) + record.remaining);
        expectedShares.set(order.accountId, shares);
      } else if (order.type === "limit") {
        const cash = (expectedCash.get(order.accountId) ?? 0) + order.limitPrice * record.remaining;
        expectedCash.set(order.accountId, cash);
      }
      if (record.status === "resting") {
        const resting = this.marketOf(record).book.get(order.id);
        if (resting?.remaining !== record.remaining) {
          problems.push(`${order.id}: book and order record disagree`);
        }
      }
    }

    for (const id of this.accounts.ids()) {
      const reserved = this.accounts.reserved(id);
      if (reserved.cash !== (expectedCash.get(id) ?? 0)) {
        problems.push(`${id}: reserved cash ${reserved.cash} != open buy orders`);
      }
      const shares = expectedShares.get(id) ?? new Map<string, number>();
      for (const symbol of new Set([...reserved.shares.keys(), ...shares.keys()])) {
        if ((reserved.shares.get(symbol) ?? 0) !== (shares.get(symbol) ?? 0)) {
          problems.push(`${id}: reserved ${symbol} != open sell orders`);
        }
      }
    }

    for (const market of this.markets.values()) {
      problems.push(...market.book.audit());
      for (const stop of market.stops) {
        if (stop.order.type !== "stop") continue;
        const due =
          stop.order.side === "buy"
            ? market.lastPrice >= stop.order.stopPrice
            : market.lastPrice <= stop.order.stopPrice;
        if (due) problems.push(`${stop.order.id}: stop is due but not triggered`);
      }
    }
    return problems;
  }
}

function toOrder(command: PlaceCommand, id: OrderId, seq: number): Order {
  const base = {
    id,
    seq,
    accountId: command.accountId,
    symbol: command.symbol,
    side: command.side,
    qty: command.qty satisfies Quantity,
  };
  switch (command.type) {
    case "market":
      return { ...base, type: "market" };
    case "limit":
      return { ...base, type: "limit", limitPrice: command.limitPrice };
    case "stop":
      return { ...base, type: "stop", stopPrice: command.stopPrice };
  }
}
