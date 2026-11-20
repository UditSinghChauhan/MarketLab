/**
 * HTTP layer: routes, validation, auth, errors, security headers and static
 * hosting of the web app. Business logic lives in the engine and the host; this
 * file only translates HTTP to commands and results to HTTP.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import {
  PlaceOrderRequest,
  type ApiError,
  type HealthResponse,
  type MarketSummary,
  type ReplayEntries,
  type ReplayHead,
  type SessionResponse,
} from "@marketlab/contracts";
import { MoneyError, parseRupees, quantity, type Command, type OrderId } from "@marketlab/engine";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { issueToken, verifyToken } from "./auth.js";
import type { Config } from "./config.js";
import { HostUnavailableError, type EngineHost } from "./host.js";
import type { InstrumentConfig } from "./instruments.js";
import type { StreamHub } from "./stream.js";
import { accountView, marketSummary, orderBook } from "./views.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REPLAY_PAGE = 1_000;

export interface AppDeps {
  readonly config: Config;
  readonly host: EngineHost;
  readonly hub: StreamHub;
  readonly instruments: readonly InstrumentConfig[];
  readonly persistence: "postgres" | "memory";
  /** Where log lines go instead of stdout; given one, the app logs even in tests. */
  readonly logStream?: { write(line: string): void };
  /** Shared with the process: set `draining` when shutdown begins. */
  readonly lifecycle?: Lifecycle;
}

export interface Lifecycle {
  /**
   * True once shutdown has begun: every request but /api/health gets 503, and
   * every response closes its connection, so no keep-alive socket outlives
   * the server.
   */
  draining: boolean;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

/** Production only: browsers then refuse plain HTTP to this host for a year. */
const HSTS = "max-age=31536000; includeSubDomains";

/**
 * The event stream carries the session token in its query string (EventSource
 * cannot send headers), so request URLs are logged without it. The path and
 * every other parameter are kept.
 */
export function redactUrl(url: string): string {
  const start = url.indexOf("?");
  if (start === -1) return url;
  const params = new URLSearchParams(url.slice(start + 1));
  if (!params.has("token")) return url;
  params.delete("token");
  const rest = params.toString();
  return rest ? `${url.slice(0, start)}?${rest}` : url.slice(0, start);
}

/**
 * Link previews (Open Graph) need absolute URLs, and the built page cannot
 * know its own address. Given the public origin, this rewrites the page's
 * root-relative preview image, page URL and canonical link for one path.
 */
export function absoluteLinks(html: string, origin: string, pathname: string): string {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const here = escape(`${origin}${pathname === "/" ? "/" : pathname.replace(/\/+$/, "")}`);
  return html
    .replace(
      /(<meta property="og:image" content=")(\/[^"]*)(")/,
      (_match, open: string, image: string, close: string) =>
        `${open}${escape(origin)}${image}${close}`,
    )
    .replace(
      /(<meta property="og:url" content=")[^"]*(")/,
      (_match, open: string, close: string) => `${open}${here}${close}`,
    )
    .replace(
      /(<link rel="canonical" href=")[^"]*(")/,
      (_match, open: string, close: string) => `${open}${here}${close}`,
    );
}

/**
 * Puts the current market summaries in the page as an inert JSON block, so the
 * terminal's first render shows live prices instead of placeholders while its
 * stream connects. `<` is escaped, so no value can close the script element.
 */
export function withInitialMarkets(html: string, markets: readonly MarketSummary[]): string {
  const json = JSON.stringify(markets).replaceAll("<", "\\u003c");
  return html.replace(
    "</head>",
    `<script type="application/json" id="initial-markets">${json}</script></head>`,
  );
}

/** The parts of Vite's build manifest (`.vite/manifest.json`) this server reads. */
export type ViteManifest = Record<
  string,
  { readonly file: string; readonly imports?: readonly string[]; readonly isEntry?: boolean }
>;

/** Pages that ship as their own chunk, and that chunk's source module. */
const PAGE_CHUNKS: readonly {
  readonly matches: (pathname: string) => boolean;
  readonly source: string;
}[] = [
  { matches: (p) => p.startsWith("/terminal/"), source: "src/terminal/Terminal.tsx" },
  { matches: (p) => p === "/replay", source: "src/replay/Replay.tsx" },
];

/**
 * Module-preload links for a page's own chunk and every chunk it imports, so
 * the browser fetches the page's code alongside the main bundle instead of
 * only once the main bundle has run. The entry chunk is skipped: the page's
 * own script tag already loads it.
 */
export function routePreloads(manifest: ViteManifest): (pathname: string) => string {
  const links = PAGE_CHUNKS.map(({ matches, source }) => {
    const files = new Set<string>();
    const visit = (key: string) => {
      const chunk = manifest[key];
      if (!chunk || chunk.isEntry || files.has(chunk.file)) return;
      files.add(chunk.file);
      for (const dependency of chunk.imports ?? []) visit(dependency);
    };
    visit(source);
    const tags = [...files].map((file) => `<link rel="modulepreload" crossorigin href="/${file}">`);
    return { matches, tags: tags.join("") };
  });
  return (pathname) => links.find((l) => l.matches(pathname))?.tags ?? "";
}

const errorBody = (code: string, message: string, details?: unknown): ApiError => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, host, hub, instruments, logStream } = deps;
  const lifecycle = deps.lifecycle ?? { draining: false };
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const securityHeaders: Record<string, string> =
    config.NODE_ENV === "production"
      ? { ...SECURITY_HEADERS, "strict-transport-security": HSTS }
      : SECURITY_HEADERS;

  const logger = {
    level: config.LOG_LEVEL,
    // The request fields Fastify logs by default, with the token taken out of the URL.
    serializers: {
      req: (request: FastifyRequest) => {
        const port = request.socket.remotePort;
        return {
          method: request.method,
          url: redactUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          ...(port === undefined ? {} : { remotePort: port }),
        };
      },
    },
    ...(logStream ? { stream: logStream } : {}),
  };
  const app = Fastify({
    logger: config.NODE_ENV === "test" && !logStream ? false : logger,
    trustProxy: true,
    bodyLimit: 16 * 1024,
    // On close, destroy every connection, not only those idle at that moment;
    // the shutdown sequence has already drained the work they were waiting for.
    forceCloseConnections: true,
  });

  // Shutdown has begun: refuse new work, and close each connection after its
  // response, including responses to requests that were already in flight.
  app.addHook("onRequest", async (request, reply) => {
    if (!lifecycle.draining) return;
    void reply.header("connection", "close");
    if (request.url === "/api/health" || request.url.startsWith("/api/health?")) return;
    return reply.status(503).send(errorBody("unavailable", "The exchange is restarting"));
  });

  // gzip/brotli for JSON and static assets. The event stream is hijacked from
  // the reply pipeline, so it is never buffered by compression.
  await app.register(compress, { threshold: 1024 });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      ...errorBody("rate_limited", `Too many requests; try again in ${context.after}`),
    }),
  });

  app.addHook("onSend", async (_request, reply) => {
    void reply.headers(securityHeaders);
    if (lifecycle.draining) void reply.header("connection", "close");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send(
        errorBody(
          "invalid_request",
          error.issues[0]?.message ?? "Invalid request",
          error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        ),
      );
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send(errorBody(error.code, error.message));
    }
    if (error instanceof HostUnavailableError) {
      return reply.status(503).send(errorBody("unavailable", "The exchange is restarting"));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send(errorBody("bad_request", (error as Error).message));
    }
    request.log.error(error);
    return reply.status(500).send(errorBody("internal", "Something went wrong"));
  });

  const limit = (max: number, timeWindow: string) => ({
    config: { rateLimit: { max: Math.ceil(max * config.RATE_LIMIT_SCALE), timeWindow } },
  });

  const requireAccount = (request: FastifyRequest, token?: string): string => {
    const header = request.headers.authorization;
    const raw = token ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!raw) throw new HttpError(401, "unauthenticated", "Start a session first");
    const result = verifyToken(raw, config.tokenSecret, Date.now());
    if (
      !result.ok ||
      result.payload.sid !== host.session.id ||
      !host.exchange.accounts.has(result.payload.aid)
    ) {
      throw new HttpError(401, "session_expired", "Your session has ended; start a new one");
    }
    return result.payload.aid;
  };

  const instrument = (symbol: string): InstrumentConfig => {
    const found = bySymbol.get(symbol.toUpperCase());
    if (!found) throw new HttpError(404, "unknown_symbol", `No market named ${symbol}`);
    return found;
  };

  // System -------------------------------------------------------------------

  // 503 when the engine can no longer write its log, so the platform restarts
  // it, and while shutting down, so no traffic is routed here. Never queries
  // the database (ADR 0007).
  app.get("/api/health", (_request, reply): HealthResponse => {
    const violations = host.exchange.audit().length;
    if (!host.healthy || lifecycle.draining) void reply.status(503);
    return {
      status: lifecycle.draining
        ? "stopping"
        : host.healthy && violations === 0
          ? "ok"
          : "degraded",
      session: host.session.id,
      seq: host.sequence,
      uptimeS: Math.round((Date.now() - host.startedAt) / 1000),
      persistence: deps.persistence,
      invariantViolations: violations,
      replay: host.replay,
      engine: host.stats(),
    };
  });

  // Market data ------------------------------------------------------------

  app.get("/api/markets", () => instruments.map((i) => marketSummary(host, i)));

  app.get<{ Params: { symbol: string } }>("/api/markets/:symbol/book", (request) => {
    return orderBook(host, instrument(request.params.symbol).symbol);
  });

  app.get<{ Params: { symbol: string } }>("/api/markets/:symbol/trades", (request) => {
    return host.data.tape(instrument(request.params.symbol).symbol, 50);
  });

  app.get<{ Params: { symbol: string } }>("/api/markets/:symbol/candles", (request) => {
    return host.data.candles(instrument(request.params.symbol).symbol);
  });

  // Session and account ----------------------------------------------------

  app.post(
    "/api/session",
    limit(10, "1 minute"),
    async (_request, reply): Promise<SessionResponse> => {
      const accountId = await host.openGuest();
      const expiresAt = Date.now() + TOKEN_TTL_MS;
      const token = issueToken(
        { aid: accountId, sid: host.session.id, exp: expiresAt },
        config.tokenSecret,
      );
      void reply.status(201);
      return { token, accountId, expiresAt };
    },
  );

  app.get("/api/account", (request) => accountView(host, instruments, requireAccount(request)));

  app.get("/api/orders", (request) => host.data.ordersOf(requireAccount(request)));

  app.post("/api/orders", limit(30, "10 seconds"), async (request, reply) => {
    const accountId = requireAccount(request);
    const body = PlaceOrderRequest.parse(request.body);
    const market = instrument(body.symbol);
    const base = {
      kind: "place",
      accountId,
      symbol: market.symbol,
      side: body.side,
      qty: quantity(body.qty),
    } as const;

    let command: Command;
    try {
      command =
        body.type === "market"
          ? { ...base, type: "market" }
          : body.type === "limit"
            ? { ...base, type: "limit", limitPrice: parseRupees(body.price) }
            : { ...base, type: "stop", stopPrice: parseRupees(body.stopPrice) };
    } catch (error) {
      if (error instanceof MoneyError) throw new HttpError(400, "invalid_price", error.message);
      throw error;
    }

    const result = await host.submit(command);
    return reply.status(result.ok ? 201 : 422).send(result);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/orders/:id",
    limit(30, "10 seconds"),
    async (request, reply) => {
      const accountId = requireAccount(request);
      const result = await host.submit({
        kind: "cancel",
        accountId,
        orderId: request.params.id as OrderId,
      });
      if (!result.ok) {
        // Someone else's order is reported as missing, so ids cannot be probed.
        throw new HttpError(404, "unknown_order", "No open order with that id");
      }
      return reply.send(result);
    },
  );

  app.get<{ Params: { id: string } }>("/api/orders/:id/trace", (request) => {
    const accountId = requireAccount(request);
    const trace = host.data.isOrderOf(request.params.id, accountId)
      ? host.data.trace(request.params.id)
      : undefined;
    if (!trace) throw new HttpError(404, "unknown_order", "No order with that id");
    return trace;
  });

  // Verified replay --------------------------------------------------------
  // Public by design: the log holds the session's inputs (who is known only by
  // an opaque guest id) so anyone can re-run the engine and check the result.

  // Flushes pending ticks to the log to fix a point to verify, so it is the
  // more tightly limited of the two.
  app.get("/api/replay", limit(6, "1 minute"), async (): Promise<ReplayHead> => {
    const { seq, stateHash, commands } = await host.checkpoint();
    return {
      session: host.session.id,
      startedAt: host.session.startedAt,
      config: host.sessionConfig,
      instruments: instruments
        .map((i) => marketSummary(host, i))
        .map((m) => ({
          symbol: m.symbol,
          name: m.name,
          sector: m.sector,
          tick: m.tick,
        })),
      seq,
      stateHash,
      commands,
      pageSize: REPLAY_PAGE,
    };
  });

  app.get<{ Querystring: { session?: string; after?: string; upto?: string } }>(
    "/api/replay/entries",
    limit(120, "1 minute"),
    async (request): Promise<ReplayEntries> => {
      const number = (value: string | undefined, name: string) => {
        const n = Number(value);
        if (value === undefined || !Number.isInteger(n) || n < 0) {
          throw new HttpError(400, "invalid_request", `${name} must be a whole number`);
        }
        return n;
      };
      const after = number(request.query.after, "after");
      const upto = number(request.query.upto, "upto");
      if (number(request.query.session, "session") !== host.session.id) {
        throw new HttpError(409, "session_ended", "That session has ended; start the replay again");
      }
      if (upto > host.sequence || after > upto) {
        throw new HttpError(400, "invalid_request", "after and upto must lie within the log");
      }
      const entries = await host.readEntries(after, Math.min(REPLAY_PAGE, upto - after));
      return { session: host.session.id, after, entries };
    },
  );

  // Streaming --------------------------------------------------------------

  app.get<{ Querystring: { symbol?: string; token?: string } }>(
    "/api/stream",
    limit(20, "1 minute"),
    (request, reply) => {
      const symbol = instrument(request.query.symbol ?? instruments[0]?.symbol ?? "").symbol;
      // EventSource cannot send headers, so the token travels in the query string.
      const accountId = request.query.token
        ? requireAccount(request, request.query.token)
        : undefined;
      void reply.hijack();
      reply.raw.setHeaders(new Map(Object.entries(securityHeaders)));
      hub.attach(reply.raw, symbol, accountId);
    },
  );

  // Web app ----------------------------------------------------------------

  const webRoot = config.WEB_DIST ? path.resolve(config.WEB_DIST) : undefined;
  if (webRoot && existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      index: false, // "/" is rendered below, like every other page
      setHeaders: (res, filePath) => {
        void res.header(
          "cache-control",
          filePath.includes(`${path.sep}assets${path.sep}`)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    });
    const indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
    const manifestFile = path.join(webRoot, ".vite", "manifest.json");
    const preloadsFor = existsSync(manifestFile)
      ? routePreloads(JSON.parse(readFileSync(manifestFile, "utf8")) as ViteManifest)
      : () => "";
    // The configured origin wins. Without one (local runs), the request's own
    // host is used, so the canonical link and preview image are always absolute.
    const configured = (config.PUBLIC_URL ?? config.RENDER_EXTERNAL_URL)?.replace(/\/+$/, "");
    const originOf = (request: FastifyRequest) =>
      configured ??
      (/^[\w.-]+(:\d+)?$/.test(request.host) ? `${request.protocol}://${request.host}` : undefined);
    const sendPage = (request: FastifyRequest, reply: FastifyReply) => {
      const origin = originOf(request);
      const { pathname } = new URL(request.url, "http://localhost");
      let html = origin ? absoluteLinks(indexHtml, origin, pathname) : indexHtml;
      const preload = preloadsFor(pathname);
      if (preload) html = html.replace("</head>", `${preload}</head>`);
      // The terminal's price heading is its largest paint; with the prices in
      // the page it paints on the first render, not after the stream connects.
      if (pathname.startsWith("/terminal/") && host.healthy) {
        html = withInitialMarkets(
          html,
          instruments.map((i) => marketSummary(host, i)),
        );
      }
      return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(html);
    };

    app.get("/", sendPage);
    app.get("/*", (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send(errorBody("not_found", "No such endpoint"));
      }
      return sendPage(request, reply);
    });
  }

  // Anything no route claimed (any method, with or without the web app) is a JSON 404.
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody("not_found", "No such endpoint")),
  );

  return app;
}
