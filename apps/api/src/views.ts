/** Builds API response objects from engine state and read models. */

import type { AccountView, MarketSummary, OrderBook, Position } from "@marketlab/contracts";

import type { EngineHost } from "./host.js";
import { GUEST_CASH, type InstrumentConfig } from "./instruments.js";
import { rupees } from "./serialize.js";

const BOOK_DEPTH = 15;

export function marketSummary(host: EngineHost, instrument: InstrumentConfig): MarketSummary {
  const stats = host.data.symbol(instrument.symbol);
  const depth = host.exchange.depth(instrument.symbol, 1);
  const open = stats?.open ?? instrument.referencePrice;
  const last = stats?.last ?? open;
  const bid = depth?.bids[0]?.price;
  const ask = depth?.asks[0]?.price;
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    sector: instrument.sector,
    tick: rupees(instrument.tickSize),
    last: rupees(last),
    open: rupees(open),
    high: rupees(stats?.high ?? last),
    low: rupees(stats?.low ?? last),
    change: rupees(last - open),
    changePct: Math.round(((last - open) / open) * 10_000) / 100,
    bid: bid === undefined ? null : rupees(bid),
    ask: ask === undefined ? null : rupees(ask),
    volume: stats?.volume ?? 0,
    trades: stats?.trades ?? 0,
  };
}

export function orderBook(host: EngineHost, symbol: string): OrderBook | undefined {
  const depth = host.exchange.depth(symbol, BOOK_DEPTH);
  if (!depth) return undefined;
  const bid = depth.bids[0]?.price;
  const ask = depth.asks[0]?.price;
  const level = (l: { price: number; qty: number; orders: number }) => ({
    price: rupees(l.price),
    qty: l.qty,
    orders: l.orders,
  });
  return {
    symbol,
    seq: host.sequence,
    bids: depth.bids.map(level),
    asks: depth.asks.map(level),
    spread: bid !== undefined && ask !== undefined ? rupees(ask - bid) : null,
    mid: bid !== undefined && ask !== undefined ? rupees(Math.floor((bid + ask) / 2)) : null,
  };
}

export function accountView(
  host: EngineHost,
  instruments: readonly InstrumentConfig[],
  accountId: string,
): AccountView {
  const snapshot = host.exchange.accounts.snapshot(accountId);
  let holdingsValue = 0;
  const positions: Position[] = [];

  for (const instrument of instruments) {
    const held = snapshot.positions[instrument.symbol];
    const basis = host.data.costBasis(accountId, instrument.symbol);
    const qty = (held?.available ?? 0) + (held?.reserved ?? 0);
    if (qty === 0 && basis.realized === 0) continue;

    const last = host.data.symbol(instrument.symbol)?.last ?? instrument.referencePrice;
    const marketValue = last * qty;
    holdingsValue += marketValue;
    positions.push({
      symbol: instrument.symbol,
      qty,
      reserved: held?.reserved ?? 0,
      avgPrice: rupees(qty === 0 ? 0 : Math.round(basis.cost / qty)),
      last: rupees(last),
      marketValue: rupees(marketValue),
      unrealizedPnl: rupees(marketValue - basis.cost),
      realizedPnl: rupees(basis.realized),
    });
  }

  const cash = snapshot.cash.available + snapshot.cash.reserved;
  const equity = cash + holdingsValue;
  return {
    accountId,
    cash: { available: rupees(snapshot.cash.available), reserved: rupees(snapshot.cash.reserved) },
    positions,
    equity: rupees(equity),
    startingEquity: rupees(GUEST_CASH),
    pnl: rupees(equity - GUEST_CASH),
    pnlPct: Math.round(((equity - GUEST_CASH) / GUEST_CASH) * 10_000) / 100,
  };
}
