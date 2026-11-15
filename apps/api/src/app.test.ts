import type {
  CommandResult,
  HealthResponse,
  OrderTrace,
  SessionResponse,
} from "@marketlab/contracts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { EngineHost } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import { StreamHub } from "./stream.js";
import { clock, startHost, testConfig } from "./test/fixtures.js";

let app: FastifyInstance;
let host: EngineHost;

beforeAll(async () => {
  const time = clock();
  host = await startHost(new MemoryLog(), time.now);
  for (let i = 0; i < 3; i++) host.tick();
  const hub = new StreamHub(host, INSTRUMENTS);
  app = await buildApp({
    config: testConfig(),
    host,
    hub,
    instruments: INSTRUMENTS,
    persistence: "memory",
  });
});
afterAll(() => app.close());

async function session(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/session" });
  expect(res.statusCode).toBe(201);
  return res.json<SessionResponse>().token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("public market data", () => {
  it("lists markets with prices as decimal strings", async () => {
    const res = await app.inject("/api/markets");
    expect(res.statusCode).toBe(200);
    const markets = res.json<{ symbol: string; last: string }[]>();
    expect(markets.map((m) => m.symbol)).toEqual(["ORBT", "QNTA", "SOLR", "HLXB"]);
    expect(markets[0]?.last).toMatch(/^\d+\.\d{2}$/);
  });

  it("serves a two-sided book, trades and candles", async () => {
    const book = (await app.inject("/api/markets/orbt/book")).json<{
      bids: unknown[];
      asks: unknown[];
    }>();
    expect(book.bids.length).toBeGreaterThan(0);
    expect(book.asks.length).toBeGreaterThan(0);
    expect((await app.inject("/api/markets/ORBT/trades")).statusCode).toBe(200);
    expect((await app.inject("/api/markets/ORBT/candles")).statusCode).toBe(200);
  });

  it("returns a JSON 404 for an unknown symbol or route", async () => {
    const res = await app.inject("/api/markets/NOPE/book");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "unknown_symbol", message: "No market named NOPE" },
    });
    expect((await app.inject("/api/nothing")).json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("reports health with zero invariant violations", async () => {
    const health = (await app.inject("/api/health")).json<HealthResponse>();
    expect(health).toMatchObject({ status: "ok", invariantViolations: 0, persistence: "memory" });
  });

  it("sets security headers", async () => {
    const res = await app.inject("/api/markets");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });
});

describe("trading", () => {
  it("requires a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { symbol: "ORBT", side: "buy", type: "market", qty: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("rejects a forged token", async () => {
    const token = await session();
    const res = await app.inject({ url: "/api/account", headers: auth(`${token}x`) });
    expect(res.statusCode).toBe(401);
  });

  it("places a market order and reflects it in the account", async () => {
    const token = await session();
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(token),
      payload: { symbol: "SOLR", side: "buy", type: "market", qty: 10 },
    });
    expect(res.statusCode).toBe(201);
    const result = res.json<CommandResult>();
    expect(result.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["order.accepted", "trade"]),
    );

    const account = (await app.inject({ url: "/api/account", headers: auth(token) })).json<{
      positions: { symbol: string; qty: number }[];
    }>();
    expect(account.positions).toEqual([expect.objectContaining({ symbol: "SOLR", qty: 10 })]);

    const trace = (
      await app.inject({ url: `/api/orders/${result.orderId ?? ""}/trace`, headers: auth(token) })
    ).json<OrderTrace>();
    expect(trace.timing?.persistMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 422 with the reason when the engine rejects an order", async () => {
    const token = await session();
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(token),
      payload: { symbol: "ORBT", side: "sell", type: "limit", qty: 5, price: "1300.00" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<CommandResult>()).toMatchObject({
      ok: false,
      rejectReason: "insufficient_shares",
    });
  });

  it.each([
    [{ symbol: "ORBT", side: "buy", type: "limit", qty: 1 }, "price"],
    [{ symbol: "ORBT", side: "buy", type: "market", qty: 1.5 }, "qty"],
    [{ symbol: "ORBT", side: "hold", type: "market", qty: 1 }, "side"],
    [{ symbol: "ORBT", side: "buy", type: "limit", qty: 1, price: "12.345" }, "price"],
  ])("validates the request body (%j)", async (payload, field) => {
    const token = await session();
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(token),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(field);
  });

  it("cancels a resting order, and hides other people's orders", async () => {
    const alice = await session();
    const bob = await session();
    const placed = (
      await app.inject({
        method: "POST",
        url: "/api/orders",
        headers: auth(alice),
        payload: { symbol: "QNTA", side: "buy", type: "limit", qty: 3, price: "700.00" },
      })
    ).json<CommandResult>();
    const url = `/api/orders/${placed.orderId ?? ""}`;

    expect((await app.inject({ method: "DELETE", url, headers: auth(bob) })).statusCode).toBe(404);
    expect((await app.inject({ url: `${url}/trace`, headers: auth(bob) })).statusCode).toBe(404);

    const cancelled = await app.inject({ method: "DELETE", url, headers: auth(alice) });
    expect(cancelled.statusCode).toBe(200);
    const orders = (await app.inject({ url: "/api/orders", headers: auth(alice) })).json<
      { status: string }[]
    >();
    expect(orders[0]?.status).toBe("cancelled");
    expect(host.exchange.audit()).toEqual([]);
  });

  it("rate-limits session creation", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await app.inject({ method: "POST", url: "/api/session", remoteAddress: "10.9.9.9" }))
          .statusCode,
      );
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("production shape: the API serving the built web app", () => {
  let served: FastifyInstance;
  let servedHost: EngineHost;
  let log: MemoryLog;

  beforeAll(async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "marketlab-web-"));
    mkdirSync(path.join(dist, "assets"));
    writeFileSync(path.join(dist, "index.html"), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(dist, "assets", "app.js"), `console.log("${"x".repeat(4_000)}")`);

    log = new MemoryLog();
    servedHost = await startHost(log, clock().now);
    served = await buildApp({
      config: { ...testConfig(), WEB_DIST: dist },
      host: servedHost,
      hub: new StreamHub(servedHost, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
  });
  afterAll(() => served.close());

  it("serves the app for deep links, so a refresh on any page works", async () => {
    for (const url of ["/", "/terminal/ORBT", "/some/unknown/page"]) {
      const res = await served.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain('<div id="root">');
    }
  });

  it("answers unknown API routes with a JSON 404, whatever the method", async () => {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await served.inject({ method, url: "/api/no-such-thing" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("compresses large responses and caches hashed assets for a year", async () => {
    const res = await served.inject({
      url: "/assets/app.js",
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("sets security headers on pages, assets and API responses", async () => {
    for (const url of ["/", "/assets/app.js", "/api/health", "/api/no-such-thing"]) {
      const res = await served.inject({ url });
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
  });

  it("reports 503 on health, and refuses orders, once the log cannot be written", async () => {
    const before = await served.inject({ url: "/api/health" });
    expect(before.statusCode).toBe(200);

    const opened = await served.inject({ method: "POST", url: "/api/session" });
    const { token } = opened.json<SessionResponse>();
    vi.spyOn(log, "append").mockRejectedValue(new Error("connection lost"));
    const order = await served.inject({
      method: "POST",
      url: "/api/orders",
      headers: { authorization: `Bearer ${token}` },
      payload: { symbol: "ORBT", side: "buy", type: "market", qty: 1 },
    });
    expect(order.statusCode).toBe(503);
    expect(order.json()).toMatchObject({ error: { code: "unavailable" } });

    const after = await served.inject({ url: "/api/health" });
    expect(after.statusCode).toBe(503);
    expect(after.json<HealthResponse>().status).toBe("degraded");
  });
});
