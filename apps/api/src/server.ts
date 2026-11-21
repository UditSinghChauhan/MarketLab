/**
 * Process entry point: wires configuration, the command log, the engine host and HTTP.
 *
 * Startup listens at once, then waits for the command log's writer lock
 * (during a deploy, until the previous instance has gone idle and released
 * it, ADR 0009), then replays, and only then hands the port to the app. Until
 * that moment every request gets 503 and /api/health says why.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import pg from "pg";

import { buildApp, type Lifecycle } from "./app.js";
import { loadConfig } from "./config.js";
import { createEventLog } from "./events.js";
import { EngineHost, HostUnavailableError } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import { connectionOptions } from "./log/connection.js";
import { PostgresLog } from "./log/postgres.js";
import { LockWaitTimeoutError, type CommandLog } from "./log/types.js";
import { closeServer, createStartingServer, listen } from "./starting.js";
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
/** Read through a function: a signal can set it while startup awaits. */
const stopping = () => shuttingDown;

/** Everything that exists once the engine is ready. */
interface Running {
  readonly log: CommandLog;
  readonly host: EngineHost;
  readonly hub: StreamHub;
  readonly app: FastifyInstance;
  readonly lifecycle: Lifecycle;
}
let running: Running | undefined;

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
  return PostgresLog.connect(
    {
      connect: async () => {
        const client = new pg.Client(options);
        client.on("error", fatal);
        await client.connect();
        return client;
      },
      disconnect: (client) => client.end(),
    },
    // During a deploy the previous instance holds the lock until it is idle.
    {
      timeoutMs: config.LOCK_WAIT_MS,
      onWaiting: (waitedMs) => {
        emit("lock_waiting", { waitedMs, timeoutMs: config.LOCK_WAIT_MS });
      },
    },
  );
}

// Installed before the server accepts traffic, so every signal from the first
// request on gets a graceful shutdown.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const starting = createStartingServer();
const { server } = starting;

/** Listens, waits for the log, replays, then hands the port to the app. */
async function main(): Promise<void> {
  const port = await listen(server, config.HOST, config.PORT);

  let log: CommandLog;
  try {
    log = await openLog();
  } catch (error) {
    if (!(error instanceof LockWaitTimeoutError)) throw error;
    // The previous instance never went idle: give up, so the deploy fails and
    // the previous instance keeps serving.
    emit(
      "lock_waiting",
      { waitedMs: config.LOCK_WAIT_MS, timeoutMs: config.LOCK_WAIT_MS, gaveUp: true },
      { level: "error", message: describeError(error) },
    );
    await closeServer(server);
    process.exit(1);
  }
  if (stopping()) return; // shutdown exits the process
  if (log instanceof PostgresLog) emit("lock_acquired", { waitedMs: log.lockWaitedMs });

  starting.setReason("replaying the command log");
  const host = await EngineHost.start({
    log,
    instruments: INSTRUMENTS,
    tickMs: config.TICK_MS,
    sessionMaxAgeMs: config.SESSION_HOURS * 60 * 60 * 1000,
    warmupTicks: Math.round((config.WARMUP_MINUTES * 60_000) / config.TICK_MS),
    snapshotMs: config.SNAPSHOT_MINUTES * 60_000,
    idleAfterMs: config.IDLE_AFTER_MS,
    maxGuests: config.MAX_GUESTS_PER_SESSION,
    onFatal: fatal,
    onWarning: (message, error) => {
      console.warn(`${message}:`, error instanceof Error ? error.message : error);
    },
    onEvent: emit,
    // A newer instance took the log while this one was idle (a deploy): refuse
    // everything and wait for SIGTERM, rather than exit and contend for the log.
    onSuperseded: (error) => {
      hub.stop();
      emit(
        "persistence_failed",
        { error: describeError(error), fatal: false },
        {
          level: "warn",
          message: "another instance owns the log; refusing all work until stopped (ADR 0009)",
        },
      );
    },
  });
  const hub = new StreamHub(host, INSTRUMENTS);
  host.watch(() => hub.size); // periodic log writes pause while nobody watches (ADR 0007)
  const lifecycle: Lifecycle = { draining: false };
  let appHandler: Parameters<typeof starting.handOver>[0] | undefined;
  const app = await buildApp({
    config,
    host,
    hub,
    instruments: INSTRUMENTS,
    persistence: log.kind,
    lifecycle,
    // The app serves on the server that is already listening.
    serverFactory: (handler) => {
      appHandler = handler;
      return server;
    },
  });
  await app.ready();
  if (stopping()) return; // shutdown exits the process
  if (!appHandler) throw new Error("The app did not take the server");

  running = { log, host, hub, app, lifecycle };
  hub.start();
  host.startClock();
  starting.handOver(appHandler);
  emit("engine_ready", {
    session: host.session.id,
    seq: host.sequence,
    replayed: host.replay.entries,
    replayMs: host.replay.ms,
    snapshotSeq: host.replay.snapshotSeq,
    persistence: log.kind,
    port,
  });
}

main().catch((error: unknown) => {
  // Bad configuration (such as the connection string) or an unreachable
  // database at startup: report it and exit, so the platform says so.
  console.error("startup failed:", error);
  process.exit(1);
});

/**
 * Graceful shutdown (SIGTERM on every deploy and restart, SIGINT locally):
 * 1. refuse new work: every request gets 503 and its connection is closed;
 *    /api/health answers 503 "stopping";
 * 2. stop the market clock and close every event stream;
 * 3. let commands already queued finish and be logged;
 * 4. log pending ticks and store a final snapshot, unless another instance
 *    has taken over the log meanwhile;
 * 5. close the HTTP server and every remaining connection;
 * 6. close the command log, then exit.
 * Before the engine is ready (waiting for the lock or replaying), nothing has
 * been written by this process: it closes the server and exits at once.
 * If all that takes longer than SHUTDOWN_DEADLINE_MS, it gives up and exits
 * with code 1, naming the step it was stuck in, before the platform kills it.
 */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const started = performance.now();
  let phase = "refusing new work";
  emit("shutdown_started", {
    signal,
    seq: running?.host.sequence ?? 0,
    ready: running !== undefined,
    deadlineMs: config.SHUTDOWN_DEADLINE_MS,
  });
  setTimeout(() => {
    emit("shutdown_deadline_exceeded", {
      signal,
      phase,
      deadlineMs: config.SHUTDOWN_DEADLINE_MS,
      seq: running?.host.sequence ?? 0,
    });
    process.exit(1);
    // Not unref'd: if shutdown stalled on a promise with nothing else
    // pending, Node would otherwise exit with code 0 and no event at all.
  }, config.SHUTDOWN_DEADLINE_MS);

  if (!running) {
    // Still waiting for the lock or replaying. The process exits without
    // closing the log's connection; PostgreSQL releases the lock with it.
    phase = "closing connections";
    await closeServer(server);
    emit("shutdown_completed", {
      signal,
      seq: 0,
      finalFlush: "not started",
      ms: Math.round(performance.now() - started),
      exitCode,
    });
    process.exit(exitCode);
  }
  const { host, hub, app, lifecycle } = running;

  lifecycle.draining = true;
  host.beginShutdown();
  phase = "closing streams";
  host.stopClock();
  hub.stop();
  phase = "finishing queued commands";
  await host.drain();
  phase = "final flush and snapshot";
  const finalFlush = await host.finalFlush().catch((error: unknown) => {
    // A failed append already reported itself through `fatal`.
    if (!(error instanceof HostUnavailableError)) {
      emit("persistence_failed", { error: describeError(error), phase: "final flush" });
    }
    exitCode = 1;
    return "failed" as const;
  });
  phase = "closing connections";
  await app.close();
  await closeServer(server);
  phase = "closing the command log";
  await running.log.close();

  emit(
    "shutdown_completed",
    {
      signal,
      seq: host.sequence,
      finalFlush,
      ms: Math.round(performance.now() - started),
      exitCode,
    },
    finalFlush === "owned-elsewhere"
      ? {
          level: "warn",
          message: "another instance owns the log; idle ticks not persisted (ADR 0007)",
        }
      : undefined,
  );
  process.exit(exitCode);
}
