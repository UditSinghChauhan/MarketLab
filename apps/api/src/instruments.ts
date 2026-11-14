/**
 * The simulated instruments. All companies are fictional.
 *
 * Each one gets its own market-maker bot; a shared pool of flow bots trades
 * across all of them. Volatility and level spacing are per instrument so the
 * charts look different from each other.
 */

import { parseRupees, type MarketConfig, type Paise } from "@marketlab/engine";

export interface InstrumentConfig extends MarketConfig {
  readonly name: string;
  readonly sector: string;
  /** Fair-value move per tick, in ticks. */
  readonly volatilityTicks: number;
  readonly levelGapTicks: number;
  readonly levelSize: number;
}

const TICK = parseRupees("0.05");

export const INSTRUMENTS: readonly InstrumentConfig[] = [
  {
    symbol: "ORBT",
    name: "Orbit Aerospace",
    sector: "Aerospace",
    tickSize: TICK,
    referencePrice: parseRupees("1250.00"),
    volatilityTicks: 10,
    levelGapTicks: 2,
    levelSize: 40,
  },
  {
    symbol: "QNTA",
    name: "Quanta Compute",
    sector: "Semiconductors",
    tickSize: TICK,
    referencePrice: parseRupees("842.50"),
    volatilityTicks: 8,
    levelGapTicks: 2,
    levelSize: 60,
  },
  {
    symbol: "SOLR",
    name: "Solaris Grid",
    sector: "Energy",
    tickSize: TICK,
    referencePrice: parseRupees("318.20"),
    volatilityTicks: 4,
    levelGapTicks: 1,
    levelSize: 150,
  },
  {
    symbol: "HLXB",
    name: "Helix Bio",
    sector: "Biotech",
    tickSize: TICK,
    referencePrice: parseRupees("2140.00"),
    volatilityTicks: 16,
    levelGapTicks: 3,
    levelSize: 20,
  },
];

/** Cash every guest starts with: ₹10,00,000. */
export const GUEST_CASH: Paise = parseRupees("1000000");

export const MAKER_PREFIX = "mm:";
export const FLOW_IDS = ["flow:1", "flow:2", "flow:3", "flow:4", "flow:5", "flow:6"] as const;
export const GUEST_PREFIX = "g_";

export const isGuest = (accountId: string): boolean => accountId.startsWith(GUEST_PREFIX);
