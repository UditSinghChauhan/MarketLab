/**
 * The claim behind the replay page, checked end to end: what the API hands out
 * (a seed, the rules, the log) is enough for an independent copy of the engine
 * to arrive at exactly the server's state.
 */

import type { ReplayEntries, ReplayHead, SessionResponse } from "@marketlab/contracts";
import { Replayer, type LogEntry } from "@marketlab/engine";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { EngineHost } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import type { CommandLog } from "./log/types.js";
import { StreamHub } from "./stream.js";
import { clock, hostOptions, pgliteLog, testConfig } from "./test/fixtures.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function serve(log: CommandLog, now: () => number, snapshotMs = 0) {
  const host = await EngineHost.start({ ...hostOptions(log, now), snapshotMs, warmupTicks: 200 });
  const app = await buildApp({
    config: testConfig(),
    host,
    hub: new StreamHub(host, INSTRUMENTS),
    instruments: INSTRUMENTS,
    persistence: log.kind,
  });
  apps.push(app);
  return { app, host };
}

async function guest(app: FastifyInstance) {
  const res = await app.inject({ method: "POST", url: "/api/session" });
  const { token } = res.json<SessionResponse>();
  return (payload: object) =>
    app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
}

/** Downloads the head and every page of entries, the way the web app does. */
async function download(app: FastifyInstance, pageSize?: number) {
  const head = (await app.inject({ url: "/api/replay" })).json<ReplayHead>();
  const entries: LogEntry[] = [];
  const size = pageSize ?? head.pageSize;
  while (entries.length < head.seq) {
    const upto = Math.min(head.seq, entries.length + size);
    const url = `/api/replay/entries?session=${String(head.session)}&after=${String(entries.length)}&upto=${String(upto)}`;
    const page = (await app.inject({ url })).json<ReplayEntries>();
    expect(page.after).toBe(entries.length);
    entries.push(...page.entries);
  }
  return { head, entries };
}

function replay(head: ReplayHead, entries: readonly LogEntry[]) {
  const replayer = new Replayer({
    config: head.config,
    entries,
    head: { seq: head.seq, stateHash: head.stateHash },
  });
  replayer.seek(replayer.totalSteps);
  return replayer;
}

/** Guests trade while the market ticks, as on a live server. */
async function trade(app: FastifyInstance, host: EngineHost, advance: (ms: number) => void) {
  const alice = await guest(app);
  const bob = await guest(app);
  for (let i = 0; i < 60; i++) {
    advance(600);
    host.tick();
    if (i === 5) await alice({ symbol: "ORBT", side: "buy", type: "market", qty: 30 });
    if (i === 20) {
      // With a client order id, sent twice: the retry is not logged, and the
      // remembered id is part of the state every replay must reach.
      const order = { symbol: "SOLR", side: "buy", type: "limit", qty: 100, price: "300.00" };
      const retried = { ...order, clientOrderId: CLIENT_ORDER_ID };
      await bob(retried);
      expect((await bob(retried)).statusCode).toBe(200);
    }
    if (i === 31)
      await alice({ symbol: "ORBT", side: "sell", type: "limit", qty: 10, price: "1300.00" });
    if (i === 44) await bob({ symbol: "HLXB", side: "sell", type: "market", qty: 5 }); // rejected
  }
}

const CLIENT_ORDER_ID = "0b6f1d7e-3c1a-4c55-9a51-7c2f3e4d5a6b";

const logs: [string, () => Promise<CommandLog>][] = [
  ["memory", () => Promise.resolve(new MemoryLog())],
  ["postgres (PGlite)", async () => (await pgliteLog()).log],
];

describe.each(logs)("verified replay over HTTP (%s log)", (_name, makeLog) => {
  it("an independent engine fed the served log reaches the server's state hash", async () => {
    const time = clock();
    const { app, host } = await serve(await makeLog(), time.now);
    await trade(app, host, time.advance);

    const { head, entries } = await download(app, 3); // small pages, to exercise paging
    const replayer = replay(head, entries);

    expect(replayer.verdict).toEqual({
      status: "verified",
      seq: head.seq,
      stateHash: head.stateHash,
    });
    expect(replayer.stateHash()).toBe(host.exchange.stateHash());
    expect(replayer.commands).toBe(head.commands);
    expect(head.seq).toBe(host.sequence);
    // Every entry records the state it was applied to, so a divergence can be located.
    expect(entries.every((e) => /^[0-9a-f]{16}$/.test(e.h ?? ""))).toBe(true);
    // The served log carries the client order id, once (the retry was not
    // logged); the hashes above include the id the exchange remembers.
    const ids = entries.flatMap((e) =>
      e.kind === "command" && e.command.kind === "place" && e.command.clientOrderId
        ? [e.command.clientOrderId]
        : [],
    );
    expect(ids).toEqual([CLIENT_ORDER_ID]);
  });

  it("still verifies from the first entry after the server restarted from a snapshot", async () => {
    const log = await makeLog();
    const time = clock();
    const first = await serve(log, time.now, 60_000);
    await trade(first.app, first.host, time.advance);
    await first.host.stop(); // stores a snapshot

    const second = await serve(log, time.now, 60_000);
    expect(second.host.replay.snapshotSeq).toBeGreaterThan(0);
    await trade(second.app, second.host, time.advance);

    const { head, entries } = await download(second.app);
    expect(replay(head, entries).verdict.status).toBe("verified");
  });
});

describe("verified replay over HTTP", () => {
  it("locates a tampered entry", async () => {
    const time = clock();
    const { app, host } = await serve(new MemoryLog(), time.now);
    await trade(app, host, time.advance);
    const { head, entries } = await download(app);

    const index = entries.findIndex((e) => e.kind === "command");
    const tampered = entries.map((e, i) =>
      i === index && e.kind === "command" && e.command.kind === "place"
        ? { ...e, command: { ...e.command, qty: 31 as never } }
        : e,
    );
    expect(replay(head, tampered).verdict).toMatchObject({ status: "diverged", seq: index + 1 });
  });

  it("exposes only the engine's inputs: opaque guest ids, no tokens or addresses", async () => {
    const time = clock();
    const { app, host } = await serve(new MemoryLog(), time.now);
    await trade(app, host, time.advance);
    const { entries } = await download(app);

    const allowed = new Set(["kind", "at", "h", "accountId", "count", "from", "command"]);
    for (const entry of entries) {
      expect(Object.keys(entry).every((key) => allowed.has(key))).toBe(true);
      if (entry.kind === "open") expect(entry.accountId).toMatch(/^g_[0-9a-f]{16}$/);
    }
    expect(JSON.stringify(entries)).not.toMatch(/token|Bearer|authorization/i);
  });

  it("validates paging and refuses another session's log", async () => {
    const time = clock();
    const { app } = await serve(new MemoryLog(), time.now);
    const head = (await app.inject({ url: "/api/replay" })).json<ReplayHead>();
    const get = (query: string) => app.inject({ url: `/api/replay/entries?${query}` });

    expect(
      (await get(`session=${String(head.session)}&after=0&upto=${String(head.seq + 1)}`))
        .statusCode,
    ).toBe(400);
    expect((await get(`session=${String(head.session)}&after=x&upto=1`)).statusCode).toBe(400);
    expect((await get(`session=${String(head.session + 1)}&after=0&upto=1`)).statusCode).toBe(409);
    const ok = await get(`session=${String(head.session)}&after=0&upto=${String(head.seq)}`);
    expect(ok.json<ReplayEntries>().entries).toHaveLength(head.seq);
  });

  it("rate-limits the endpoint that writes to the log", async () => {
    const time = clock();
    const { app } = await serve(new MemoryLog(), time.now);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push((await app.inject({ url: "/api/replay" })).statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(6);
    expect(statuses.at(-1)).toBe(429);
  });
});
