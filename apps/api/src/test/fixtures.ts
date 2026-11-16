/** Shared fixtures for API tests. */

import { PGlite } from "@electric-sql/pglite";
import { paise, quantity, type Command } from "@marketlab/engine";

import { loadConfig } from "../config.js";
import { EngineHost, type HostOptions } from "../host.js";
import { INSTRUMENTS } from "../instruments.js";
import { PostgresLog } from "../log/postgres.js";
import type { CommandLog } from "../log/types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A controllable clock starting at a fixed instant. */
export function clock(start = Date.UTC(2026, 10, 14, 9, 15)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Snapshots are off by default, so tests of replay really replay the whole log. */
export function hostOptions(log: CommandLog, now: () => number): HostOptions {
  return {
    log,
    instruments: INSTRUMENTS,
    tickMs: 600,
    sessionMaxAgeMs: DAY_MS,
    now,
    seed: 42,
    snapshotMs: 0,
  };
}

export async function startHost(log: CommandLog, now: () => number): Promise<EngineHost> {
  return EngineHost.start(hostOptions(log, now));
}

export async function pgliteLog(): Promise<{ log: PostgresLog; db: PGlite }> {
  const db = new PGlite();
  const log = await PostgresLog.open(db);
  return { log, db };
}

export const testConfig = () => loadConfig({ NODE_ENV: "test", TOKEN_SECRET: "x".repeat(40) });

export const buy = (accountId: string, symbol: string, qty: number, price?: string): Command =>
  price === undefined
    ? { kind: "place", accountId, symbol, side: "buy", type: "market", qty: quantity(qty) }
    : {
        kind: "place",
        accountId,
        symbol,
        side: "buy",
        type: "limit",
        qty: quantity(qty),
        limitPrice: paise(Math.round(Number(price) * 100)),
      };

export const sell = (accountId: string, symbol: string, qty: number, price: string): Command => ({
  kind: "place",
  accountId,
  symbol,
  side: "sell",
  type: "limit",
  qty: quantity(qty),
  limitPrice: paise(Math.round(Number(price) * 100)),
});
