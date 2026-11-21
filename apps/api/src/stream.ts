/**
 * Server-sent events hub.
 *
 * Each browser holds one connection for one symbol, optionally authenticated.
 * - Trades, candles and the caller's own order events are pushed as they happen.
 * - Order-book snapshots are coalesced: a symbol is marked dirty on change and
 *   sent at most every `bookIntervalMs`, so a burst of 50 engine events costs
 *   one snapshot, not 50.
 * - Market summaries and the caller's account are pushed once a second.
 * - A client whose socket buffer passes 1 MB is disconnected (slow consumer),
 *   so one stalled tab cannot grow server memory without bound.
 */

import type { ServerResponse } from "node:http";

import type { StreamMessage, TradePrint } from "@marketlab/contracts";

import type { EngineHost, HostUpdate } from "./host.js";
import type { InstrumentConfig } from "./instruments.js";
import { rupees, toEventView } from "./serialize.js";
import { accountView, marketSummary, orderBook } from "./views.js";

const MAX_BUFFERED_BYTES = 1_000_000;

interface Client {
  readonly res: ServerResponse;
  readonly symbol: string;
  readonly accountId: string | undefined;
}

export interface StreamOptions {
  readonly bookIntervalMs?: number;
  readonly marketsIntervalMs?: number;
  readonly heartbeatMs?: number;
}

export class StreamHub {
  private readonly clients = new Set<Client>();
  private readonly dirtyBooks = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | undefined;
  /** Set by `stop`: streams that arrive afterwards are refused, not left open forever. */
  private stopped = false;

  constructor(
    private readonly host: EngineHost,
    private readonly instruments: readonly InstrumentConfig[],
    private readonly options: StreamOptions = {},
  ) {}

  get size(): number {
    return this.clients.size;
  }

  start(): void {
    const unsubscribe = this.host.subscribe((update) => {
      this.onUpdate(update);
    });
    // A new session: every stream's account (and market) belongs to the old
    // one. End them all; browsers reconnect, and one whose token has expired
    // is told so and starts a new guest account.
    const unwatch = this.host.onSessionStart(() => {
      this.endAll();
    });
    this.unsubscribe = () => {
      unsubscribe();
      unwatch();
    };
    this.timers.push(
      setInterval(() => {
        this.flushBooks();
      }, this.options.bookIntervalMs ?? 250),
      setInterval(() => {
        this.pushMarkets();
      }, this.options.marketsIntervalMs ?? 1_000),
      setInterval(() => {
        for (const client of this.clients) this.write(client, ": ping\n\n");
      }, this.options.heartbeatMs ?? 15_000),
    );
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.endAll();
  }

  private endAll(): void {
    for (const client of this.clients) client.res.end();
    this.clients.clear();
    this.dirtyBooks.clear();
  }

  attach(res: ServerResponse, symbol: string, accountId: string | undefined): void {
    if (this.stopped) {
      // Nothing would ever close this stream, and the server could not stop.
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        connection: "close",
      });
      res.end(
        JSON.stringify({ error: { code: "unavailable", message: "The exchange is restarting" } }),
      );
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const client: Client = { res, symbol, accountId };
    this.clients.add(client);
    res.on("close", () => this.clients.delete(client));

    this.send(client, {
      type: "hello",
      session: this.host.session.id,
      serverTime: Date.now(),
    });
    this.send(client, { type: "markets", markets: this.markets() });
    const book = orderBook(this.host, symbol);
    if (book) this.send(client, { type: "book", book });
    this.send(client, { type: "trades", symbol, trades: this.host.data.tape(symbol, 50) });
    if (accountId) {
      this.send(client, {
        type: "account",
        account: accountView(this.host, this.instruments, accountId),
      });
    }
  }

  private onUpdate(update: HostUpdate): void {
    for (const symbol of update.symbols) this.dirtyBooks.add(symbol);

    const trades = new Map<string, TradePrint[]>();
    for (const e of update.events) {
      if (e.type !== "trade") continue;
      const list = trades.get(e.symbol) ?? [];
      list.push({
        seq: e.seq,
        symbol: e.symbol,
        price: rupees(e.price),
        qty: e.qty,
        aggressor: e.aggressor,
        time: update.at,
      });
      trades.set(e.symbol, list);
    }
    // Newest first, like the tape snapshot. Reversed once per symbol: every
    // client on that symbol shares the same array.
    for (const list of trades.values()) list.reverse();

    for (const client of this.clients) {
      const prints = trades.get(client.symbol);
      if (prints) {
        this.send(client, { type: "trades", symbol: client.symbol, trades: prints });
        const candle = this.host.data.lastCandle(client.symbol);
        if (candle) this.send(client, { type: "candle", symbol: client.symbol, candle });
      }

      const { accountId } = client;
      if (accountId && update.accounts.has(accountId)) {
        const mine = update.events.filter((e) => this.concerns(e, accountId));
        if (mine.length > 0) {
          this.send(client, { type: "orders", events: mine.map((e) => toEventView(e, update.at)) });
        }
        this.send(client, {
          type: "account",
          account: accountView(this.host, this.instruments, accountId),
        });
      }
    }
  }

  private concerns(event: HostUpdate["events"][number], accountId: string): boolean {
    const { data } = this.host;
    switch (event.type) {
      case "order.accepted":
        return event.order.accountId === accountId;
      case "order.rejected":
        return false; // returned to the caller directly
      case "trade":
        return event.buyAccountId === accountId || event.sellAccountId === accountId;
      default:
        return data.isOrderOf(event.orderId, accountId);
    }
  }

  private flushBooks(): void {
    for (const symbol of this.dirtyBooks) {
      const book = orderBook(this.host, symbol);
      if (!book) continue;
      for (const client of this.clients) {
        if (client.symbol === symbol) this.send(client, { type: "book", book });
      }
    }
    this.dirtyBooks.clear();
  }

  private pushMarkets(): void {
    if (this.clients.size === 0) return;
    const markets = this.markets();
    for (const client of this.clients) {
      this.send(client, { type: "markets", markets });
      if (client.accountId) {
        this.send(client, {
          type: "account",
          account: accountView(this.host, this.instruments, client.accountId),
        });
      }
    }
  }

  private markets() {
    return this.instruments.map((i) => marketSummary(this.host, i));
  }

  private send(client: Client, message: StreamMessage): void {
    this.write(client, `data: ${JSON.stringify(message)}\n\n`);
  }

  private write(client: Client, chunk: string): void {
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      this.clients.delete(client);
      client.res.destroy();
      return;
    }
    client.res.write(chunk);
  }
}
