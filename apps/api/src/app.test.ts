import type {
  CommandResult,
  HealthResponse,
  OrderTrace,
  SessionResponse,
} from "@marketlab/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { absoluteLinks, buildApp, redactUrl, withInitialMarkets } from "./app.js";
import { loadConfig } from "./config.js";
import { EngineHost } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import { StreamHub } from "./stream.js";
import { buy, clock, hostOptions, startHost, testConfig } from "./test/fixtures.js";

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

  it("sends Strict-Transport-Security in production only", async () => {
    expect((await app.inject("/api/markets")).headers["strict-transport-security"]).toBeUndefined();
    const production = await buildApp({
      config: loadConfig({
        NODE_ENV: "production",
        TOKEN_SECRET: "x".repeat(40),
        LOG_LEVEL: "silent",
      }),
      host,
      hub: new StreamHub(host, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
    try {
      for (const url of ["/api/markets", "/api/no-such-route"]) {
        expect((await production.inject(url)).headers["strict-transport-security"]).toBe(
          "max-age=31536000; includeSubDomains",
        );
      }
    } finally {
      await production.close();
    }
  });
});

describe("redactUrl", () => {
  it.each([
    ["/api/stream", "/api/stream"],
    ["/api/stream?symbol=ORBT", "/api/stream?symbol=ORBT"],
    ["/api/stream?token=abc.def", "/api/stream"],
    ["/api/stream?symbol=ORBT&token=abc.def", "/api/stream?symbol=ORBT"],
    ["/api/stream?token=abc&symbol=ORBT&after=7", "/api/stream?symbol=ORBT&after=7"],
    ["/api/stream?token=a&symbol=ORBT&token=b", "/api/stream?symbol=ORBT"],
  ])("%s is logged as %s", (url, logged) => {
    expect(redactUrl(url)).toBe(logged);
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

describe("client address", () => {
  /** An app of its own, so rate-limit buckets from other tests do not interfere. */
  async function served(
    env: Record<string, string> = {},
    logStream?: { write(line: string): void },
  ) {
    const own = await startHost(new MemoryLog(), clock().now);
    return buildApp({
      config: loadConfig({ NODE_ENV: "test", TOKEN_SECRET: "x".repeat(40), ...env }),
      host: own,
      hub: new StreamHub(own, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
      ...(logStream ? { logStream } : {}),
    });
  }

  /** Statuses of 12 session requests (the limit is 10 a minute), each with its own headers. */
  async function sessions(app: FastifyInstance, headers: (i: number) => Record<string, string>) {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/session",
        remoteAddress: "10.0.0.1", // the proxy: every request arrives from it
        headers: headers(i),
      });
      statuses.push(res.statusCode);
    }
    return statuses;
  }

  it("ignores a forged X-Forwarded-For: rate limits still apply", async () => {
    const app = await served();
    try {
      const statuses = await sessions(app, (i) => ({
        "x-forwarded-for": `198.51.100.${String(i)}`,
      }));
      expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await app.close();
    }
  });

  it("keys rate limits on CLIENT_IP_HEADER when it is configured", async () => {
    const app = await served({ CLIENT_IP_HEADER: "CF-Connecting-IP" });
    try {
      // One visitor, whatever X-Forwarded-For says: limited.
      const one = await sessions(app, (i) => ({
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": `198.51.100.${String(i)}`,
      }));
      expect(one.slice(10)).toEqual([429, 429]);
      // Twelve visitors behind the same proxy: each has a bucket of its own.
      const many = await sessions(app, (i) => ({
        "cf-connecting-ip": `203.0.113.${String(100 + i)}`,
      }));
      expect(many.every((s) => s === 201)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("falls back to the connecting address when the header is missing or not one address", async () => {
    const app = await served({ CLIENT_IP_HEADER: "cf-connecting-ip" });
    try {
      const values = ["", "not-an-address", "203.0.113.7, 198.51.100.1"];
      const statuses = await sessions(app, (i) => {
        const value = values[i % values.length] ?? "";
        return value ? { "cf-connecting-ip": `${value}${String(i)}` } : {};
      });
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await app.close();
    }
  });

  it("refuses a list header as CLIENT_IP_HEADER", () => {
    for (const header of ["X-Forwarded-For", "forwarded"]) {
      expect(() =>
        loadConfig({ NODE_ENV: "test", TOKEN_SECRET: "x".repeat(40), CLIENT_IP_HEADER: header }),
      ).toThrow(/single address/);
    }
  });

  it("never logs a client address", async () => {
    const lines: string[] = [];
    const app = await served(
      { CLIENT_IP_HEADER: "cf-connecting-ip", LOG_LEVEL: "info" },
      { write: (line) => lines.push(line) },
    );
    try {
      await app.inject({
        url: "/api/markets",
        remoteAddress: "10.0.0.1",
        headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" },
      });
    } finally {
      await app.close();
    }
    const logged = lines.join("\n");
    expect(logged).toContain("/api/markets"); // the request was logged
    for (const address of ["10.0.0.1", "203.0.113.7", "198.51.100.9"]) {
      expect(logged).not.toContain(address);
    }
  });
});

describe("guest limit", () => {
  it("answers 503 'the demo is full' once the session has MAX_GUESTS_PER_SESSION guests", async () => {
    const own = await EngineHost.start({
      ...hostOptions(new MemoryLog(), clock().now),
      maxGuests: 2,
    });
    const app = await buildApp({
      config: testConfig(),
      host: own,
      hub: new StreamHub(own, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
    try {
      const open = () => app.inject({ method: "POST", url: "/api/session" });
      expect((await open()).statusCode).toBe(201);
      expect((await open()).statusCode).toBe(201);
      const full = await open();
      expect(full.statusCode).toBe(503);
      expect(full.json()).toEqual({
        error: { code: "demo_full", message: "The demo is full until the market resets" },
      });
    } finally {
      await app.close();
    }
  });
});

describe("withInitialMarkets", () => {
  it("adds an inert JSON block that no value can break out of", () => {
    const market = { symbol: "ORBT", name: "</script><script>alert(1)</script>" };
    const html = withInitialMarkets("<html><head><title>x</title></head><body></body></html>", [
      market,
    ] as unknown as Parameters<typeof withInitialMarkets>[1]);
    expect(html).toContain('<script type="application/json" id="initial-markets">');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const json = /id="initial-markets">(.*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(JSON.parse(json)).toEqual([market]);
  });
});

describe("absoluteLinks", () => {
  const html = [
    '<link rel="canonical" href="/" />',
    '<meta property="og:url" content="/" />',
    '<meta property="og:image" content="/og.png" />',
  ].join("\n");

  it("points the preview image, page URL and canonical link at the public origin", () => {
    const out = absoluteLinks(html, "https://marketlab.example", "/terminal/ORBT/");
    expect(out).toContain(
      '<link rel="canonical" href="https://marketlab.example/terminal/ORBT" />',
    );
    expect(out).toContain(
      '<meta property="og:url" content="https://marketlab.example/terminal/ORBT" />',
    );
    expect(out).toContain(
      '<meta property="og:image" content="https://marketlab.example/og.png" />',
    );
  });

  it("cannot be used to inject markup through the path", () => {
    const out = absoluteLinks(html, "https://marketlab.example", '/"><script>alert(1)</script>');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('/">');
  });
});

describe("while shutting down", () => {
  async function drainable() {
    const log = new MemoryLog();
    const drainingHost = await startHost(log, clock().now);
    drainingHost.tick();
    const hub = new StreamHub(drainingHost, INSTRUMENTS);
    const lifecycle = { draining: false };
    const served = await buildApp({
      config: testConfig(),
      host: drainingHost,
      hub,
      instruments: INSTRUMENTS,
      persistence: "memory",
      lifecycle,
    });
    const token = (
      await served.inject({ method: "POST", url: "/api/session" })
    ).json<SessionResponse>().token;
    return { log, host: drainingHost, hub, lifecycle, served, token };
  }

  const order = { symbol: "ORBT", side: "buy", type: "market", qty: 1 };

  it("refuses every request but health with 503, closing the connection", async () => {
    const { served, lifecycle, token } = await drainable();
    lifecycle.draining = true;
    try {
      for (const request of [
        { method: "GET", url: "/api/markets" },
        { method: "POST", url: "/api/session" },
        { method: "GET", url: "/api/stream?symbol=ORBT" },
        { method: "GET", url: "/api/replay" },
        { method: "POST", url: "/api/orders", headers: auth(token), payload: order },
      ] as const) {
        const res = await served.inject(request);
        expect(res.statusCode, request.url).toBe(503);
        expect(res.headers.connection, request.url).toBe("close");
        expect(res.json()).toEqual({
          error: { code: "unavailable", message: "The exchange is restarting" },
        });
      }
    } finally {
      await served.close();
    }
  });

  it("answers health with 503 'stopping', without touching the database", async () => {
    const { served, lifecycle } = await drainable();
    expect((await served.inject("/api/health")).statusCode).toBe(200);
    lifecycle.draining = true;
    try {
      const res = await served.inject("/api/health");
      expect(res.statusCode).toBe(503);
      expect(res.headers.connection).toBe("close");
      expect(res.json<HealthResponse>().status).toBe("stopping");
    } finally {
      await served.close();
    }
  });

  it("never logs or applies an order that reaches the host after shutdown began", async () => {
    // The request passed the HTTP gate just before draining began.
    const { served, host: closing, log, token } = await drainable();
    const before = (await log.readEntries(closing.session.id, 0, 1_000)).length;
    const hash = closing.exchange.stateHash();
    closing.beginShutdown();
    try {
      const res = await served.inject({
        method: "POST",
        url: "/api/orders",
        headers: auth(token),
        payload: order,
      });
      expect(res.statusCode).toBe(503);
      expect((await log.readEntries(closing.session.id, 0, 1_000)).length).toBe(before);
      expect(closing.exchange.stateHash()).toBe(hash);
    } finally {
      await served.close();
    }
  });

  it("finishes and logs commands queued before shutdown; drain waits for them", async () => {
    const { served, host: closing, log } = await drainable();
    const accountId = await closing.openGuest();
    closing.tick();
    const before = (await log.readEntries(closing.session.id, 0, 1_000)).length;
    let finished = false;
    const queued = closing.submit(buy(accountId, "ORBT", 1)).then((result) => {
      finished = true;
      return result;
    });
    closing.beginShutdown();
    await closing.drain();
    try {
      expect(finished).toBe(true);
      expect((await queued).ok).toBe(true);
      // The pending ticks, then the order.
      expect((await log.readEntries(closing.session.id, 0, 1_000)).length).toBe(before + 2);
    } finally {
      await served.close();
    }
  });

  it("refuses everything, fast, once another instance has taken over the log", async () => {
    const { served, host: old, log, token } = await drainable();
    // While this instance was idle, a new one took over and wrote to the session.
    await log.suspend();
    await log.append(old.session.id, old.sequence + 1, { kind: "ticks", count: 1, from: 0, at: 0 });
    try {
      const started = performance.now();
      const res = await served.inject({
        method: "POST",
        url: "/api/orders",
        headers: auth(token),
        payload: order,
      });
      expect(res.statusCode).toBe(503);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(old.superseded).toBe(true);
      expect(old.healthy).toBe(true); // not a failure: the process waits to be stopped

      const health = await served.inject("/api/health");
      expect(health.statusCode).toBe(503);
      expect(health.json<HealthResponse>()).toMatchObject({
        status: "stopping",
        reason: "another instance owns the command log",
      });
      const markets = await served.inject("/api/markets");
      expect(markets.statusCode).toBe(503);
      expect(markets.headers.connection).toBe("close");
    } finally {
      await served.close();
    }
  });

  it("refuses an event stream that arrives after the hub stopped", async () => {
    const { served, hub } = await drainable();
    hub.stop();
    try {
      const res = await served.inject("/api/stream?symbol=ORBT");
      expect(res.statusCode).toBe(503);
      expect(res.headers.connection).toBe("close");
    } finally {
      await served.close();
    }
  });
});
