/**
 * Live market state from the server-sent event stream.
 *
 * One EventSource per (symbol, session). The browser reconnects on its own after
 * a dropped connection; a stream that closes for good (for example a 401 after
 * the market session rolled over) is reported through `onClosed`.
 */

import type {
  AccountView,
  Candle,
  EventView,
  MarketSummary,
  OrderBook,
  StreamMessage,
  TradePrint,
} from "@marketlab/contracts";
import { useEffect, useReducer, useRef } from "react";

const MAX_TRADES = 60;

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export interface MarketState {
  readonly status: ConnectionStatus;
  readonly symbol: string;
  readonly markets: readonly MarketSummary[];
  readonly book: OrderBook | null;
  readonly trades: readonly TradePrint[];
  readonly candles: readonly Candle[];
  readonly account: AccountView | null;
  /** Increments whenever the caller's own orders change. */
  readonly ordersVersion: number;
  readonly lastOrderEvents: readonly EventView[];
}

type Action =
  | { type: "reset"; symbol: string }
  | { type: "status"; status: ConnectionStatus }
  | { type: "candles"; symbol: string; candles: Candle[] }
  | { type: "message"; message: StreamMessage };

const initial = (symbol: string): MarketState => ({
  status: "connecting",
  symbol,
  markets: [],
  book: null,
  trades: [],
  candles: [],
  account: null,
  ordersVersion: 0,
  lastOrderEvents: [],
});

function upsertCandle(candles: readonly Candle[], candle: Candle): Candle[] {
  const last = candles.at(-1);
  if (last?.time === candle.time) return [...candles.slice(0, -1), candle];
  if (last && candle.time < last.time) return [...candles];
  return [...candles, candle].slice(-480);
}

export function reducer(state: MarketState, action: Action): MarketState {
  switch (action.type) {
    case "reset":
      return initial(action.symbol);
    case "status":
      return { ...state, status: action.status };
    case "candles":
      if (action.symbol !== state.symbol) return state;
      // Keep any candle the stream delivered while the history request was in flight.
      return {
        ...state,
        candles: state.candles.reduce(upsertCandle, action.candles),
      };
    case "message": {
      const m = action.message;
      switch (m.type) {
        case "hello":
          return { ...state, status: "live" };
        case "markets":
          return { ...state, markets: m.markets };
        case "book":
          return m.book.symbol === state.symbol ? { ...state, book: m.book } : state;
        case "trades":
          if (m.symbol !== state.symbol) return state;
          return { ...state, trades: [...m.trades, ...state.trades].slice(0, MAX_TRADES) };
        case "candle":
          if (m.symbol !== state.symbol) return state;
          return { ...state, candles: upsertCandle(state.candles, m.candle) };
        case "account":
          return { ...state, account: m.account };
        case "orders":
          return {
            ...state,
            ordersVersion: state.ordersVersion + 1,
            lastOrderEvents: m.events,
          };
      }
    }
  }
}

export function useMarketStream(
  symbol: string,
  token: string | null,
  onClosed?: () => void,
): MarketState {
  const [state, dispatch] = useReducer(reducer, symbol, initial);
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useEffect(() => {
    dispatch({ type: "reset", symbol });
    const query = new URLSearchParams({ symbol });
    if (token) query.set("token", token);
    const source = new EventSource(`/api/stream?${query.toString()}`);

    source.onmessage = (event: MessageEvent<string>) => {
      dispatch({ type: "message", message: JSON.parse(event.data) as StreamMessage });
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) onClosedRef.current?.();
      else dispatch({ type: "status", status: "reconnecting" });
    };

    let cancelled = false;
    fetch(`/api/markets/${symbol}/candles`)
      .then((r) => (r.ok ? (r.json() as Promise<Candle[]>) : []))
      .then((candles) => {
        if (!cancelled) dispatch({ type: "candles", symbol, candles });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      source.close();
    };
  }, [symbol, token]);

  return state;
}
