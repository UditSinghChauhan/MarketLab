import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS, pgliteLog } from "../test/fixtures.js";
import { MemoryLog } from "./memory.js";
import { PostgresLog } from "./postgres.js";
import type { CommandLog, LogEntry } from "./types.js";

const T0 = Date.UTC(2026, 10, 14);
const entry = (n: number): LogEntry => ({ kind: "ticks", count: n, from: T0, at: T0 + n });

const cases: [string, () => Promise<CommandLog>][] = [
  ["memory", () => Promise.resolve(new MemoryLog())],
  ["postgres (PGlite)", async () => (await pgliteLog()).log],
];

describe.each(cases)("%s command log", (_name, make) => {
  it("resumes the current session with its entries in order", async () => {
    const log = await make();
    const session = await log.openSession(T0, DAY_MS, 7);
    for (let i = 1; i <= 3; i++) await log.append(session.id, i, entry(i));

    const resumed = await log.openSession(T0 + 1_000, DAY_MS, 99);
    expect(resumed).toMatchObject({ id: session.id, seed: 7 });
    expect(resumed.entries).toEqual([entry(1), entry(2), entry(3)]);
  });

  it("starts a fresh session once the current one is too old", async () => {
    const log = await make();
    const first = await log.openSession(T0, DAY_MS, 7);
    await log.append(first.id, 1, entry(1));

    const next = await log.openSession(T0 + DAY_MS, DAY_MS, 8);
    expect(next.id).not.toBe(first.id);
    expect(next).toMatchObject({ seed: 8, entries: [] });
  });

  it("rejects a duplicate sequence number", async () => {
    const log = await make();
    const session = await log.openSession(T0, DAY_MS, 7);
    await log.append(session.id, 1, entry(1));
    await expect(log.append(session.id, 1, entry(2))).rejects.toThrow();
  });

  it("suspends, then resumes where it left off", async () => {
    const log = await make();
    const session = await log.openSession(T0, DAY_MS, 7);
    for (let i = 1; i <= 2; i++) await log.append(session.id, i, entry(i));

    await log.suspend();
    expect(log.connected).toBe(false);
    await log.resume(session.id, 2);
    expect(log.connected).toBe(true);
    await log.resume(session.id, 2); // already connected: nothing to do
    await log.append(session.id, 3, entry(3));
    expect((await log.openSession(T0, DAY_MS, 7)).entries).toHaveLength(3);
  });

  it("refuses to resume a session another writer added to meanwhile", async () => {
    const log = await make();
    const session = await log.openSession(T0, DAY_MS, 7);
    await log.append(session.id, 1, entry(1));
    await log.suspend();
    await log.append(session.id, 2, entry(2)); // someone else, while this engine was away
    await expect(log.resume(session.id, 1)).rejects.toThrow(/changed/);
  });

  it("reconnects for a read while suspended, and still checks the head on resume", async () => {
    const log = await make();
    const session = await log.openSession(T0, DAY_MS, 7);
    await log.append(session.id, 1, entry(1));
    await log.suspend();
    await log.append(session.id, 2, entry(2)); // someone else
    expect(await log.readEntries(session.id, 0, 10)).toHaveLength(2);
    expect(log.connected).toBe(true);
    await expect(log.resume(session.id, 1)).rejects.toThrow(/changed/);
  });

  it("round-trips every entry kind", async () => {
    const log = await make();
    const session = await log.openSession(T0, DAY_MS, 7);
    const entries: LogEntry[] = [
      { kind: "open", accountId: "g_1", at: T0 },
      {
        kind: "command",
        at: T0 + 1,
        command: {
          kind: "place",
          accountId: "g_1",
          symbol: "ORBT",
          side: "buy",
          type: "limit",
          qty: 5 as never,
          limitPrice: 125_000 as never,
        },
      },
      {
        kind: "command",
        at: T0 + 2,
        command: { kind: "cancel", accountId: "g_1", orderId: "ord_9" as never },
      },
      entry(4),
    ];
    for (const [i, e] of entries.entries()) await log.append(session.id, i + 1, e);
    expect((await log.openSession(T0, DAY_MS, 1)).entries).toEqual(entries);
  });
});

describe("postgres command log", () => {
  it("fails loudly on a corrupt entry instead of replaying it", async () => {
    const { log, db } = await pgliteLog();
    const session = await log.openSession(T0, DAY_MS, 7);
    await db.query("INSERT INTO log_entries (session_id, seq, entry) VALUES ($1, 1, $2)", [
      session.id,
      JSON.stringify({ kind: "command", at: 1, command: { kind: "place" } }),
    ]);
    await expect(log.openSession(T0, DAY_MS, 7)).rejects.toThrow();
  });

  it("closes its connection when suspended and opens one, once, when used again", async () => {
    const db = new PGlite();
    const connector = {
      connects: 0,
      disconnects: 0,
      connect() {
        this.connects += 1;
        return Promise.resolve(db);
      },
      disconnect() {
        this.disconnects += 1;
        return Promise.resolve();
      },
    };
    const log = await PostgresLog.connect(connector);
    const session = await log.openSession(T0, DAY_MS, 7);
    await log.append(session.id, 1, entry(1));
    expect(connector).toMatchObject({ connects: 1, disconnects: 0 });

    await log.suspend();
    expect(connector).toMatchObject({ connects: 1, disconnects: 1 });
    // Two callers at once while suspended share one reconnect: a second
    // connection would find the writer lock taken by the first.
    await Promise.all([log.readEntries(session.id, 0, 10), log.resume(session.id, 1)]);
    expect(connector).toMatchObject({ connects: 2, disconnects: 1 });
    await log.close();
    expect(connector.disconnects).toBe(2);
  });
});

// Needs a real server: PGlite has a single connection, so it cannot show two writers.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("postgres single-writer lock", () => {
  const clients: pg.Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.end()));
    clients.length = 0;
  });

  const connect = async () => {
    const client = new pg.Client({ connectionString: url });
    clients.push(client);
    await client.connect();
    return client;
  };

  it("refuses a second engine process", async () => {
    await PostgresLog.open(await connect());
    await expect(PostgresLog.open(await connect())).rejects.toThrow(/lock/);
  });

  it("releases the lock while suspended, and fails at once if it is taken meanwhile", async () => {
    const disconnect = (client: pg.Client) => {
      clients.splice(clients.indexOf(client), 1);
      return client.end();
    };
    const first = await PostgresLog.connect({ connect, disconnect });
    const session = await first.openSession(Date.now(), DAY_MS, 7);
    await first.suspend();

    // Suspended, the first process holds no lock, so another one can start...
    const second = await PostgresLog.open(await connect());
    // ...and the first one, waking, must fail rather than wait: the second
    // never lets go, so waiting for the lock would hang until the timer below.
    // (The bound is generous because reconnecting to a remote server, such as
    // Neon over TLS, takes seconds on its own.)
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("resume waited for the lock"));
      }, 10_000);
    });
    await expect(Promise.race([first.resume(session.id, 0), waited])).rejects.toThrow(
      /Another engine process holds the command-log lock/,
    );
    clearTimeout(timer);
    expect(first.connected).toBe(false);
    await second.close();
  });
});
