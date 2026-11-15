/** Process entry point: wires configuration, the command log, the engine host and HTTP. */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
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

/**
 * The log can no longer be written. The host already refuses new work and
 * /api/health answers 503; give requests in flight a moment to receive their
 * 503, then exit so the platform restarts the process and replays the log.
 */
function fatal(error: unknown): void {
  console.error("fatal:", error);
  setTimeout(() => process.exit(1), 500);
}

async function openLog(): Promise<CommandLog> {
  if (!config.DATABASE_URL) {
    if (config.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    console.warn("DATABASE_URL not set: using an in-memory command log (state is lost on restart)");
    return new MemoryLog();
  }
  const client = new pg.Client(connectionOptions(config.DATABASE_URL));
  client.on("error", fatal);
  await client.connect();
  return PostgresLog.open(client, () => client.end());
}

const log = await openLog();
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
});
const hub = new StreamHub(host, INSTRUMENTS);
const app = await buildApp({ config, host, hub, instruments: INSTRUMENTS, persistence: log.kind });

app.log.info(
  {
    session: host.session.id,
    replayed: host.replay.entries,
    replayMs: host.replay.ms,
    snapshotSeq: host.replay.snapshotSeq,
  },
  "engine ready",
);

hub.start();
host.startClock();
await app.listen({ host: config.HOST, port: config.PORT });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  hub.stop();
  await host.stop(); // flushes pending ticks to the log
  await app.close();
  await log.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
