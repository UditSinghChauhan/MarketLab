/**
 * The API contract shared by the server and the web app.
 *
 * Requests are zod schemas, validated on the server and reused by the client
 * form. Responses are plain types. Money crosses the wire as decimal rupee
 * strings ("1250.05"), never floats; the server converts to integer paise at
 * the boundary.
 */

import type { LogEntry, SessionConfig } from "@marketlab/engine";
import { z } from "zod";

export const SIDES = ["buy", "sell"] as const;
export const ORDER_TYPES = ["market", "limit", "stop"] as const;

export type Side = (typeof SIDES)[number];
export type OrderType = (typeof ORDER_TYPES)[number];

export const MAX_ORDER_QTY = 100_000;

/** A rupee amount as a decimal string with at most two decimals. */
export const Rupees = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter a rupee amount like 1250.05");

const symbol = z.string().regex(/^[A-Z]{2,6}$/, "Unknown symbol");
const side = z.enum(SIDES);
const qty = z
  .number()
  .int("Quantity must be a whole number")
  .min(1, "Quantity must be at least 1")
  .max(MAX_ORDER_QTY, `Quantity can be at most ${String(MAX_ORDER_QTY)}`);

export const PlaceOrderRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("market"), symbol, side, qty }),
  z.object({ type: z.literal("limit"), symbol, side, qty, price: Rupees }),
  z.object({ type: z.literal("stop"), symbol, side, qty, stopPrice: Rupees }),
]);
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequest>;

// Market data -------------------------------------------------------------

export interface Instrument {
  readonly symbol: string;
  readonly name: string;
  readonly sector: string;
  readonly tick: string;
}

export interface MarketSummary extends Instrument {
  readonly last: string;
  /** Price at the start of the session. */
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly change: string;
  readonly changePct: number;
  readonly bid: string | null;
  readonly ask: string | null;
  readonly volume: number;
  readonly trades: number;
}

export interface BookLevel {
  readonly price: string;
  readonly qty: number;
  readonly orders: number;
}

export interface OrderBook {
  readonly symbol: string;
  /** Engine sequence number this snapshot reflects. */
  readonly seq: number;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly spread: string | null;
  readonly mid: string | null;
}

export interface TradePrint {
  readonly seq: number;
  readonly symbol: string;
  readonly price: string;
  readonly qty: number;
  readonly aggressor: Side;
  readonly time: number;
}

export interface Candle {
  /** Bucket start, epoch milliseconds. */
  readonly time: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: number;
}

// Account -----------------------------------------------------------------

export interface Position {
  readonly symbol: string;
  readonly qty: number;
  readonly reserved: number;
  readonly avgPrice: string;
  readonly last: string;
  readonly marketValue: string;
  readonly unrealizedPnl: string;
  readonly realizedPnl: string;
}

export interface AccountView {
  readonly accountId: string;
  readonly cash: { readonly available: string; readonly reserved: string };
  readonly positions: readonly Position[];
  readonly equity: string;
  readonly startingEquity: string;
  readonly pnl: string;
  readonly pnlPct: number;
}

export type OrderStatus = "pending_stop" | "resting" | "filled" | "cancelled";

export interface OrderView {
  readonly id: string;
  readonly symbol: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: number;
  readonly filled: number;
  readonly remaining: number;
  readonly price: string | null;
  readonly stopPrice: string | null;
  readonly avgFillPrice: string | null;
  readonly status: OrderStatus;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// Engine events (the inspector's raw material) -----------------------------

interface EventBase {
  readonly seq: number;
  /** Server time the event was produced, epoch milliseconds. */
  readonly at: number;
}

export type EventView =
  | (EventBase & {
      readonly type: "order.accepted";
      readonly orderId: string;
      readonly symbol: string;
      readonly side: Side;
      readonly orderType: OrderType;
      readonly qty: number;
      readonly price: string | null;
      readonly stopPrice: string | null;
    })
  | (EventBase & { readonly type: "order.rejected"; readonly reason: string })
  | (EventBase & {
      readonly type: "trade";
      readonly symbol: string;
      readonly price: string;
      readonly qty: number;
      readonly buyOrderId: string;
      readonly sellOrderId: string;
      readonly aggressor: Side;
    })
  | (EventBase & {
      readonly type: "order.rested";
      readonly orderId: string;
      readonly price: string;
      readonly remaining: number;
    })
  | (EventBase & { readonly type: "order.filled"; readonly orderId: string })
  | (EventBase & {
      readonly type: "order.cancelled";
      readonly orderId: string;
      readonly remaining: number;
      readonly reason: string;
    })
  | (EventBase & {
      readonly type: "stop.triggered";
      readonly orderId: string;
      readonly lastPrice: string;
    });

export interface CommandTiming {
  /** When the request reached the engine queue, epoch milliseconds. */
  readonly receivedAt: number;
  /** Time spent waiting for earlier commands in the single-writer queue. */
  readonly queueMs: number;
  /** Time to append the command to the durable log before applying it. */
  readonly persistMs: number;
  /** Time the matching engine spent on the command, microseconds. */
  readonly engineUs: number;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly orderId: string | null;
  readonly rejectReason: string | null;
  readonly events: readonly EventView[];
  readonly timing: CommandTiming;
}

/** One order's journey through the engine, for the inspector. */
export interface OrderTrace {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: number;
  readonly timing: CommandTiming | null;
  readonly events: readonly EventView[];
}

// Session and system ------------------------------------------------------

export interface SessionResponse {
  readonly token: string;
  readonly accountId: string;
  readonly expiresAt: number;
}

export interface EngineStats {
  readonly commands: number;
  readonly trades: number;
  readonly openOrders: number;
  /** Rolling engine latency over recent commands, microseconds. */
  readonly p50Us: number;
  readonly p99Us: number;
}

export interface HealthResponse {
  readonly status: "ok" | "degraded";
  readonly session: number;
  readonly seq: number;
  readonly uptimeS: number;
  readonly persistence: "postgres" | "memory";
  readonly invariantViolations: number;
  /**
   * How the last start rebuilt state: log entries replayed, milliseconds taken,
   * and the snapshot it started from (the log sequence it covers; 0 if none).
   */
  readonly replay: {
    readonly entries: number;
    readonly ms: number;
    readonly snapshotSeq: number;
  };
  readonly engine: EngineStats;
}

// Verified replay -----------------------------------------------------------

/**
 * Everything needed to rebuild the current session somewhere else: its seed
 * and rules, and the point a replay must reach. Unlike the rest of the API,
 * this carries the engine's own inputs unchanged (prices as integer paise),
 * because the browser feeds them to the same engine code.
 */
export interface ReplayHead {
  readonly session: number;
  readonly startedAt: number;
  readonly config: SessionConfig;
  /** Names for display; the engine does not read them. */
  readonly instruments: readonly Instrument[];
  /** The log sequence the replay covers and the server's state hash right after it. */
  readonly seq: number;
  readonly stateHash: string;
  /** Engine commands the server has processed in this session, bots included. */
  readonly commands: number;
  /** Largest number of entries one page returns. */
  readonly pageSize: number;
}

/** One page of the command log. Account ids are the opaque guest ids the log stores; nothing else identifies a visitor. */
export interface ReplayEntries {
  readonly session: number;
  /** The entries follow this sequence number. */
  readonly after: number;
  readonly entries: readonly LogEntry[];
}

export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

// Streaming ---------------------------------------------------------------

export type StreamMessage =
  | { readonly type: "hello"; readonly session: number; readonly serverTime: number }
  | { readonly type: "markets"; readonly markets: readonly MarketSummary[] }
  | { readonly type: "book"; readonly book: OrderBook }
  | { readonly type: "trades"; readonly symbol: string; readonly trades: readonly TradePrint[] }
  | { readonly type: "candle"; readonly symbol: string; readonly candle: Candle }
  | { readonly type: "orders"; readonly events: readonly EventView[] }
  | { readonly type: "account"; readonly account: AccountView };
