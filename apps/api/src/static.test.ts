/** The production shape: one process serving the API and the built web app. */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HealthResponse, SessionResponse } from "@marketlab/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { EngineHost } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import { StreamHub } from "./stream.js";
import { clock, startHost, testConfig } from "./test/fixtures.js";

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
