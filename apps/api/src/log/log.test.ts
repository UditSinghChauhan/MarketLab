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
});

// Needs a real server: PGlite has a single connection, so it cannot show two writers.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("postgres single-writer lock", () => {
  const clients: pg.Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.end()));
    clients.length = 0;
  });

  it("refuses a second engine process", async () => {
    const connect = async () => {
      const client = new pg.Client({ connectionString: url });
      clients.push(client);
      await client.connect();
      return client;
    };
    await PostgresLog.open(await connect());
    await expect(PostgresLog.open(await connect())).rejects.toThrow(/lock/);
  });
});
