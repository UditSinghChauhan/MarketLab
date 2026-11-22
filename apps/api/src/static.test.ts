/** The production shape: one process serving the API and the built web app. */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HealthResponse, MarketSummary, SessionResponse } from "@marketlab/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
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
    writeFileSync(
      path.join(dist, "index.html"),
      '<!doctype html><html><head><title>MarketLab</title></head><body><div id="root"></div></body></html>',
    );
    writeFileSync(path.join(dist, "assets", "app.js"), `console.log("${"x".repeat(4_000)}")`);
    mkdirSync(path.join(dist, ".vite"));
    writeFileSync(
      path.join(dist, ".vite", "manifest.json"),
      JSON.stringify({
        "index.html": { file: "assets/index-a1.js", isEntry: true },
        "src/terminal/Terminal.tsx": {
          file: "assets/Terminal-b2.js",
          imports: ["index.html", "_Panel-c3.js"],
        },
        "_Panel-c3.js": { file: "assets/Panel-c3.js", imports: ["index.html"] },
        "src/replay/Replay.tsx": { file: "assets/Replay-d4.js", imports: ["_Panel-c3.js"] },
      }),
    );

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
    for (const url of [
      "/",
      "/terminal",
      "/terminal/ORBT",
      "/terminal/NOPE", // the app redirects an unknown market
      "/replay",
      "/replay/",
      "/Replay", // the app's router ignores case
      "/replay?from=menu",
    ]) {
      const res = await served.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain('<div id="root">');
    }
  });

  it("answers an unknown page with 404, and still serves the app to say so", async () => {
    for (const url of ["/some/unknown/page", "/terminal/ORBT/extra", "/replays"]) {
      const res = await served.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain('<div id="root">');
    }
  });

  it("answers a missing file with a plain 404, not the app's HTML", async () => {
    for (const url of ["/assets/gone-a1.js", "/favicon.ico", "/terminal/ORBT.json"]) {
      const res = await served.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).not.toContain('<div id="root">');
    }
  });

  it("puts live market summaries in terminal pages only", async () => {
    const block = /<script type="application\/json" id="initial-markets">(.*?)<\/script><\/head>/;
    const terminal = (await served.inject({ url: "/terminal/QNTA" })).body;
    const markets = JSON.parse(block.exec(terminal)?.[1] ?? "null") as MarketSummary[];
    expect(markets.map((m) => m.symbol)).toEqual(["ORBT", "QNTA", "SOLR", "HLXB"]);
    expect(markets[0]?.last).toMatch(/^\d+\.\d{2}$/);

    for (const url of ["/", "/replay", "/some/unknown/page"]) {
      expect((await served.inject({ url })).body).not.toContain("initial-markets");
    }
  });

  it("preloads a page's own chunks from its HTML, and never serves the manifest", async () => {
    const preloads = async (url: string) =>
      [
        ...(await served.inject({ url })).body.matchAll(
          /rel="modulepreload" crossorigin href="([^"]+)"/g,
        ),
      ].map((m) => m[1]);
    expect(await preloads("/terminal/ORBT")).toEqual([
      "/assets/Terminal-b2.js",
      "/assets/Panel-c3.js",
    ]);
    expect(await preloads("/replay")).toEqual(["/assets/Replay-d4.js", "/assets/Panel-c3.js"]);
    expect(await preloads("/")).toEqual([]);

    expect((await served.inject({ url: "/.vite/manifest.json" })).body).not.toContain("isEntry");
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

describe("link previews: the origin comes from configuration, never from request headers", () => {
  const forged = {
    host: "evil.example",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
  };

  async function page(env: Record<string, string>) {
    const dist = mkdtempSync(path.join(tmpdir(), "marketlab-web-"));
    writeFileSync(
      path.join(dist, "index.html"),
      [
        "<!doctype html><html><head>",
        '<link rel="canonical" href="/" vite-ignore />',
        '<meta property="og:url" content="/" vite-ignore />',
        '<meta property="og:image" content="/og.png" />',
        "</head><body></body></html>",
      ].join(""),
    );
    const own = await startHost(new MemoryLog(), clock().now);
    const app = await buildApp({
      config: {
        ...loadConfig({ NODE_ENV: "test", TOKEN_SECRET: "x".repeat(40), ...env }),
        WEB_DIST: dist,
      },
      host: own,
      hub: new StreamHub(own, INSTRUMENTS),
      instruments: INSTRUMENTS,
      persistence: "memory",
    });
    try {
      return (await app.inject({ url: "/terminal/ORBT", headers: forged })).body;
    } finally {
      await app.close();
    }
  }

  it("uses PUBLIC_URL, or Render's address, when set", async () => {
    for (const env of [
      { PUBLIC_URL: "https://marketlab.example/" },
      { RENDER_EXTERNAL_URL: "https://marketlab.example" },
    ]) {
      const html = await page(env);
      expect(html).toContain(
        '<link rel="canonical" href="https://marketlab.example/terminal/ORBT"',
      );
      expect(html).toContain(
        '<meta property="og:image" content="https://marketlab.example/og.png"',
      );
      expect(html).not.toContain("evil.example");
    }
  });

  it("falls back to this server's own local address, not the request's Host", async () => {
    const html = await page({ PORT: "8123" });
    expect(html).toContain('<meta property="og:url" content="http://localhost:8123/terminal/ORBT"');
    expect(html).not.toContain("evil.example");
  });
});
