/**
 * Live market state from the server-sent event stream.
 *
 * One EventSource per (symbol, session). The browser reconnects on its own after
 * a dropped connection. When the stream closes for good, the hook asks why: a
 * 401 means the market session rolled over and is reported through
 * `onSessionEnded`; anything else (a gateway error while the server restarts)
 * is retried, keeping the guest's account.
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
import { useEffect, useReducer, useRef, useState } from "react";

import { initialMarkets } from "./initialMarkets";

const MAX_TRADES = 60;
const RECONNECT_MS = 3_000;

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export interface MarketState {
  readonly status: ConnectionStatus;
  /** The market session the stream last greeted with; null before the first hello. */
  readonly session: number | null;
  readonly symbol: string;
  readonly markets: readonly MarketSummary[];
  readonly book: OrderBook | null;
  readonly trades: readonly TradePrint[];
  readonly candles: readonly Candle[];
  /** False until the candle history and the tape have arrived, so panels show a skeleton, not "empty". */
  readonly candlesLoaded: boolean;
  readonly tradesLoaded: boolean;
  readonly account: AccountView | null;
  /** Increments whenever the caller's own orders change. */
  readonly ordersVersion: number;
  readonly lastOrderEvents: readonly EventView[];
}

type Action =
  | { type: "reset"; symbol: string }
  | { type: "session" }
  | { type: "status"; status: ConnectionStatus }
  | { type: "candles"; symbol: string; candles: Candle[] }
  | { type: "message"; message: StreamMessage };

const initial = (symbol: string): MarketState => ({
  status: "connecting",
  session: null,
  symbol,
  markets: initialMarkets(),
  book: null,
  trades: [],
  candles: [],
  candlesLoaded: false,
  tradesLoaded: false,
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

/**
 * The tape, newest first, each trade once. Every connection starts with a
 * snapshot of recent trades that overlaps what is already shown (a session's
 * stream replacing the visitor's, a reconnect), so trades merge by seq rather
 * than being prepended.
 */
function mergeTrades(incoming: readonly TradePrint[], current: readonly TradePrint[]) {
  const bySeq = new Map<number, TradePrint>();
  for (const t of current) bySeq.set(t.seq, t);
  for (const t of incoming) bySeq.set(t.seq, t);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, MAX_TRADES);
}

export function reducer(state: MarketState, action: Action): MarketState {
  switch (action.type) {
    case "reset":
      return initial(action.symbol);
    case "session":
      // Another account: its own data goes; the market on screen stays.
      return { ...state, account: null, lastOrderEvents: [] };
    case "status":
      return { ...state, status: action.status };
    case "candles":
      if (action.symbol !== state.symbol) return state;
      // Keep any candle the stream delivered while the history request was in flight.
      return {
        ...state,
        candlesLoaded: true,
        candles: state.candles.reduce(upsertCandle, action.candles),
      };
    case "message": {
      const m = action.message;
      switch (m.type) {
        case "hello":
          // A new market session numbers its trades from 1 again, so merging by seq
          // would bury its trades under the old session's: the tape starts over and
          // shows its skeleton until the new snapshot arrives. Candles are keyed by
          // time, so they carry on.
          if (state.session !== null && m.session !== state.session) {
            return {
              ...state,
              status: "live",
              session: m.session,
              trades: [],
              tradesLoaded: false,
            };
          }
          return { ...state, status: "live", session: m.session };
        case "markets":
          return { ...state, markets: m.markets };
        case "book":
          return m.book.symbol === state.symbol ? { ...state, book: m.book } : state;
        case "trades":
          if (m.symbol !== state.symbol) return state;
          return {
            ...state,
            tradesLoaded: true,
            trades: mergeTrades(m.trades, state.trades),
          };
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
  options: { onSessionEnded?: () => void; enabled?: boolean } = {},
): MarketState {
  const { onSessionEnded, enabled = true } = options;
  const [state, dispatch] = useReducer(reducer, symbol, initial);
  const [attempt, setAttempt] = useState(0);
  const onSessionEndedRef = useRef(onSessionEnded);
  useEffect(() => {
    onSessionEndedRef.current = onSessionEnded;
  }, [onSessionEnded]);

  // A different market starts from empty. A different session (a visitor's
  // first, or a fresh account) only clears that account's data: the public
  // market stays on screen rather than flashing back to placeholders.
  useEffect(() => {
    dispatch({ type: "reset", symbol });
  }, [symbol]);
  useEffect(() => {
    dispatch({ type: "session" });
  }, [token]);

  useEffect(() => {
    if (!enabled) {
      dispatch({ type: "status", status: "connecting" });
      return;
    }
    const query = new URLSearchParams({ symbol });
    if (token) query.set("token", token);
    const source = new EventSource(`/api/stream?${query.toString()}`);
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    source.onmessage = (event: MessageEvent<string>) => {
      dispatch({ type: "message", message: JSON.parse(event.data) as StreamMessage });
    };
    source.onerror = () => {
      dispatch({ type: "status", status: "reconnecting" });
      if (source.readyState !== EventSource.CLOSED) return;
      const sessionEnded = token
        ? fetch("/api/account", { headers: { authorization: `Bearer ${token}` } }).then(
            (response) => response.status === 401,
            () => false,
          )
        : Promise.resolve(false);
      void sessionEnded.then((ended) => {
        if (cancelled) return;
        if (ended) onSessionEndedRef.current?.();
        else {
          retry = setTimeout(() => {
            setAttempt((n) => n + 1);
          }, RECONNECT_MS);
        }
      });
    };

    fetch(`/api/markets/${symbol}/candles`)
      .then((r) => (r.ok ? (r.json() as Promise<Candle[]>) : []))
      .then((candles) => {
        if (!cancelled) dispatch({ type: "candles", symbol, candles });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      clearTimeout(retry);
      source.close();
    };
  }, [symbol, token, enabled, attempt]);

  return state;
}
