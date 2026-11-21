/**
 * Process-level test harness: builds the API bundle, runs it as Render does
 * (`node dist/server.js`, production settings) against a real PostgreSQL
 * database of its own, and follows its lifecycle through the structured
 * events it prints (apps/api/src/events.ts).
 *
 * Each server gets a fresh database, so tests cannot see each other's log or
 * advisory lock (both are per database).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pg from "pg";

import type { LifecycleEvent } from "../events.js";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** The advisory-lock key the command log takes (apps/api/src/log/postgres.ts). */
export const WRITER_LOCK = 0x6d6c6162;

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The bundle `startServer` runs; set by `buildServer` (each test file has its own). */
let serverScript: string | undefined;

/**
 * Bundles the API exactly as `npm run build` does, into a file of the test
 * suite's own (`dist/test-<suite>.js`): suites run in parallel, and must not
 * overwrite each other's bundle while one is starting.
 */
export async function buildServer(suite: string): Promise<string> {
  const outfile = path.join("dist", `test-${suite}.js`);
  await promisify(execFile)(process.execPath, ["build.js", outfile], { cwd: API_DIR });
  serverScript = path.join(API_DIR, outfile);
  return serverScript;
}

/** Runs `work` with a connection to `url`, closing it afterwards. */
export async function withClient<T>(url: string, work: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

/** Creates an empty database next to `adminUrl`'s, for one test. */
export async function createDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `marketlab_proc_${randomBytes(6).toString("hex")}`;
  await withClient(adminUrl, (db) => db.query(`CREATE DATABASE ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    drop: () =>
      withClient(adminUrl, async (db) => {
        await db.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [name],
        );
        await db.query(`DROP DATABASE IF EXISTS ${name}`);
      }),
  };
}

/** The latest session's log head and snapshot position (and hash), and how many sessions exist. */
export async function logState(url: string) {
  return withClient(url, async (db) => {
    const { rows } = await db.query<{
      session: string;
      head: number;
      snapshot: number | null;
      hash: string | null;
      sessions: number;
    }>(
      `SELECT s.id AS session,
              COALESCE((SELECT MAX(seq) FROM log_entries WHERE session_id = s.id), 0) AS head,
              (SELECT seq FROM snapshots WHERE session_id = s.id) AS snapshot,
              (SELECT state_hash FROM snapshots WHERE session_id = s.id) AS hash,
              (SELECT COUNT(*)::int FROM sessions) AS sessions
         FROM sessions s ORDER BY s.id DESC LIMIT 1`,
    );
    const row = rows[0];
    if (!row) throw new Error("no session in the log");
    return {
      session: Number(row.session),
      head: row.head,
      snapshotSeq: row.snapshot,
      snapshotHash: row.hash,
      sessions: row.sessions,
    };
  });
}

/** GET /api/health: the status code and the parsed body. */
export async function health(
  base: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/health`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Locks the log's table in an open transaction, so the server's next INSERT
 * waits (as a slow database would make it) until `release`. `waiting()`
 * resolves once some INSERT is blocked on it.
 */
export async function holdLogTable(url: string, name: string) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query("BEGIN");
  await db.query("LOCK TABLE log_entries IN EXCLUSIVE MODE");
  return {
    waiting: () =>
      eventually(
        async () => {
          const { rows } = await db.query<{ n: number }>(
            "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
            [name],
          );
          return (rows[0]?.n ?? 0) > 0;
        },
        5_000,
        "a write to wait for the log table",
      ),
    release: async () => {
      await db.query("COMMIT");
      await db.end();
    },
  };
}

/** Sessions holding the command log's writer lock (an advisory lock) on that database. */
export async function writerLockHolders(url: string): Promise<number> {
  return withClient(url, async (db) => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objid = $1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [WRITER_LOCK],
    );
    return rows[0]?.n ?? 0;
  });
}

/** Logged user commands of the latest session, as `{ kind, qty }`. */
export async function loggedCommands(url: string) {
  return withClient(url, async (db) => {
    const { rows } = await db.query<{ kind: string; qty: number | null }>(
      `SELECT entry->'command'->>'kind' AS kind, (entry->'command'->>'qty')::int AS qty
         FROM log_entries
        WHERE session_id = (SELECT MAX(id) FROM sessions) AND entry->>'kind' = 'command'
        ORDER BY seq`,
    );
    return rows;
  });
}

/** Connections other than the caller's own to database `name`. */
export async function connectionsTo(adminUrl: string, name: string): Promise<number> {
  return withClient(adminUrl, async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    return rows[0]?.n ?? 0;
  });
}

/** Polls `check` until it returns true, or fails after `ms`. */
export async function eventually(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

export interface ServerEvent {
  readonly event: LifecycleEvent;
  readonly msg: string;
  readonly level: number;
  readonly [field: string]: unknown;
}

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** `Date.now()` when the process exited. */
  readonly at: number;
}

/**
 * A failure message for an assertion on `exit`: a process killed by a signal
 * has `code === null`, so the signal is what tells the two cases apart.
 */
export function describeExit(exit: Exit, output: string): string {
  return `exit.code=${String(exit.code)} exit.signal=${String(exit.signal)}\n${output}`;
}

export interface ServerProcess {
  readonly base: string;
  readonly child: ChildProcess;
  readonly events: ServerEvent[];
  /** Everything the process printed, for failure messages. */
  output(): string;
  /** Resolves with the first event of that name (already seen or still to come). */
  waitFor(event: LifecycleEvent, ms?: number): Promise<ServerEvent>;
  readonly exited: Promise<Exit>;
  /** Sends a signal and returns when it was sent. */
  signal(signal: NodeJS.Signals): number;
}

export interface StartOptions {
  readonly databaseUrl: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Wait for `engine_ready` before returning (default true). */
  readonly ready?: boolean;
}

/** Spawns the built server with production settings and a short market clock. */
export async function startServer(options: StartOptions): Promise<ServerProcess> {
  if (!serverScript) throw new Error("call buildServer() first");
  const port = await freePort();
  const child = spawn(process.execPath, ["--enable-source-maps", serverScript], {
    cwd: API_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: options.databaseUrl,
      TOKEN_SECRET: "process-test-secret-0123456789abcdef0123",
      TICK_MS: "100",
      WARMUP_MINUTES: "1",
      LOG_LEVEL: "warn",
      RATE_LIMIT_SCALE: "100",
      ...options.env,
    },
  });

  const events: ServerEvent[] = [];
  const waiters: { event: LifecycleEvent; resolve: (e: ServerEvent) => void }[] = [];
  let printed = "";
  let partial = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    printed += chunk;
    partial += chunk;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || !("event" in parsed)) continue;
      const event = parsed as ServerEvent;
      events.push(event);
      for (const waiter of waiters.filter((w) => w.event === event.event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    printed += chunk;
  });

  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal, at: Date.now() });
    });
  });

  const server: ServerProcess = {
    base: `http://127.0.0.1:${String(port)}`,
    child,
    events,
    output: () => printed,
    exited,
    waitFor: (event, ms = 15_000) => {
      const seen = events.find((e) => e.event === event);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no ${event} within ${String(ms)} ms. Output:\n${printed}`));
        }, ms);
        waiters.push({
          event,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
        void exited.then(() => {
          clearTimeout(timer);
          reject(new Error(`exited before ${event}. Output:\n${printed}`));
        });
      });
    },
    signal: (signal) => {
      child.kill(signal);
      return Date.now();
    },
  };
  if (options.ready ?? true) await server.waitFor("engine_ready");
  return server;
}

/** Opens a guest session on `base`; returns its bearer token. */
export async function openGuest(base: string): Promise<string> {
  const res = await fetch(`${base}/api/session`, { method: "POST" });
  if (res.status !== 201) throw new Error(`session: ${String(res.status)}`);
  return ((await res.json()) as { token: string }).token;
}

/** Places a market buy of `qty` ORBT; returns the HTTP status (0: connection failed). */
export async function placeOrder(base: string, token: string, qty: number): Promise<number> {
  try {
    const res = await fetch(`${base}/api/orders`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "market", symbol: "ORBT", side: "buy", qty }),
    });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}
