/**
 * Engine micro-benchmark: in-process throughput and per-command latency.
 * Run with `npm run bench -w @marketlab/engine` (builds first).
 *
 * Measures Exchange.submit only — no network, no database. The bot market
 * generates the order flow: one maker re-quoting 5 levels per side, 20 takers.
 */
import { Exchange, MarketSimulator, parseRupees } from "./dist/index.js";
const ex = new Exchange([
  { symbol: "ACME", tickSize: parseRupees("0.05"), referencePrice: parseRupees("100") },
]);
ex.accounts.open("maker", parseRupees("100000000"), { ACME: 10_000_000 });
const takers = Array.from({ length: 20 }, (_, i) => `t${i}`);
for (const t of takers) ex.accounts.open(t, parseRupees("10000000"), { ACME: 100_000 });
const sim = new MarketSimulator(ex, {
  symbol: "ACME",
  seed: 1,
  makerId: "maker",
  takerIds: takers,
  takerProbability: 0.5,
});
for (let i = 0; i < 2000; i++) sim.step(); // warm up
let commands = 0,
  trades = 0;
const orig = ex.submit.bind(ex);
const lat = [];
ex.submit = (c) => {
  commands++;
  const t0 = process.hrtime.bigint();
  const ev = orig(c);
  lat.push(Number(process.hrtime.bigint() - t0));
  trades += ev.filter((e) => e.type === "trade").length;
  return ev;
};
const start = process.hrtime.bigint();
for (let i = 0; i < 20000; i++) sim.step();
const secs = Number(process.hrtime.bigint() - start) / 1e9;
lat.sort((a, b) => a - b);
const pct = (p) => (lat[Math.floor(p * lat.length)] / 1000).toFixed(1);
console.log({
  node: process.version,
  commands,
  trades,
  secs: secs.toFixed(2),
  commandsPerSec: Math.round(commands / secs),
  p50_us: pct(0.5),
  p99_us: pct(0.99),
  audit: ex.audit().length,
});
