/** Process entry point: wires configuration, the command log, the engine host and HTTP. */

import pg from "pg";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EngineHost } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import { PostgresLog } from "./log/postgres.js";
import type { CommandLog } from "./log/types.js";
import { StreamHub } from "./stream.js";

const config = loadConfig();

function fatal(error: unknown): never {
  console.error("fatal:", error);
  // Exit so the platform restarts the process; startup replays the log.
  process.exit(1);
}

async function openLog(): Promise<CommandLog> {
  if (!config.DATABASE_URL) {
    if (config.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    console.warn("DATABASE_URL not set: using an in-memory command log (state is lost on restart)");
    return new MemoryLog();
  }
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
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
  onFatal: fatal,
});
const hub = new StreamHub(host, INSTRUMENTS);
const app = await buildApp({ config, host, hub, instruments: INSTRUMENTS, persistence: log.kind });

app.log.info(
  { session: host.session.id, replayed: host.replay.entries, replayMs: host.replay.ms },
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
