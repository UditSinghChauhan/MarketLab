/** Process entry point: wires configuration, the command log, the engine host and HTTP. */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { buildApp, type Lifecycle } from "./app.js";
import { loadConfig } from "./config.js";
import { createEventLog } from "./events.js";
import { EngineHost } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import { connectionOptions } from "./log/connection.js";
import { PostgresLog } from "./log/postgres.js";
import type { CommandLog } from "./log/types.js";
import { StreamHub } from "./stream.js";

const loaded = loadConfig();
// Serve the web build next to this package by default (apps/web/dist), whether
// running from src/ in development or dist/ in production.
const bundledWeb = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const config = {
  ...loaded,
  WEB_DIST: loaded.WEB_DIST ?? (existsSync(bundledWeb) ? bundledWeb : undefined),
};
const emit = createEventLog();
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The log can no longer be written. The host already refuses new work and
 * /api/health answers 503; give requests in flight a moment to receive their
 * 503, then exit so the platform restarts the process and replays the log.
 */
function fatal(error: unknown): void {
  emit("persistence_failed", { error: describeError(error), fatal: true });
  // Shutting down already: let it finish closing, then exit with an error.
  if (shuttingDown) {
    exitCode = 1;
    return;
  }
  setTimeout(() => process.exit(1), 500);
}

let shuttingDown = false;
let exitCode = 0;

async function openLog(): Promise<CommandLog> {
  if (!config.DATABASE_URL) {
    if (config.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    console.warn("DATABASE_URL not set: using an in-memory command log (state is lost on restart)");
    return new MemoryLog();
  }
  const options = connectionOptions(config.DATABASE_URL);
  // The log closes its connection while the exchange is idle and opens a new
  // one when it is used again. A connection lost while open is fatal: the
  // engine may hold ticks the log does not, so the process restarts and replays.
  return PostgresLog.connect({
    connect: async () => {
      const client = new pg.Client(options);
      client.on("error", fatal);
      await client.connect();
      return client;
    },
    disconnect: (client) => client.end(),
  });
}

const log = await openLog();
if (log.kind === "postgres") emit("lock_acquired", { waitedMs: 0 });
const host = await EngineHost.start({
  log,
  instruments: INSTRUMENTS,
  tickMs: config.TICK_MS,
  sessionMaxAgeMs: config.SESSION_HOURS * 60 * 60 * 1000,
  warmupTicks: Math.round((config.WARMUP_MINUTES * 60_000) / config.TICK_MS),
  snapshotMs: config.SNAPSHOT_MINUTES * 60_000,
  onFatal: fatal,
  onWarning: (message, error) => {
    console.warn(`${message}:`, error instanceof Error ? error.message : error);
  },
  onEvent: emit,
});
const hub = new StreamHub(host, INSTRUMENTS);
host.watch(() => hub.size); // periodic log writes pause while nobody watches (ADR 0007)
const lifecycle: Lifecycle = { draining: false };
const app = await buildApp({
  config,
  host,
  hub,
  instruments: INSTRUMENTS,
  persistence: log.kind,
  lifecycle,
});

hub.start();
host.startClock();
await app.listen({ host: config.HOST, port: config.PORT });
const address = app.server.address();
emit("engine_ready", {
  session: host.session.id,
  seq: host.sequence,
  replayed: host.replay.entries,
  replayMs: host.replay.ms,
  snapshotSeq: host.replay.snapshotSeq,
  persistence: log.kind,
  port: typeof address === "object" && address ? address.port : config.PORT,
});

/**
 * Graceful shutdown (SIGTERM on every deploy and restart, SIGINT locally):
 * 1. refuse new work: every request gets 503 and its connection is closed;
 *    /api/health answers 503 "stopping";
 * 2. stop the market clock and close every event stream;
 * 3. let commands already queued finish and be logged;
 * 4. log pending ticks and store a final snapshot;
 * 5. close the HTTP server and every remaining connection;
 * 6. close the command log, then exit.
 */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const started = performance.now();
  emit("shutdown_started", { signal, seq: host.sequence });

  lifecycle.draining = true;
  host.beginShutdown();
  host.stopClock();
  hub.stop();
  await host.drain();
  await host.stop();
  await app.close();
  await log.close();

  emit("shutdown_completed", {
    signal,
    seq: host.sequence,
    ms: Math.round(performance.now() - started),
    exitCode,
  });
  process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
