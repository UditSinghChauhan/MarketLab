/**
 * HTTP layer: routes, validation, auth, errors, security headers and static
 * hosting of the web app. Business logic lives in the engine and the host; this
 * file only translates HTTP to commands and results to HTTP.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import {
  PlaceOrderRequest,
  type ApiError,
  type HealthResponse,
  type SessionResponse,
} from "@marketlab/contracts";
import { MoneyError, parseRupees, quantity, type Command, type OrderId } from "@marketlab/engine";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { issueToken, verifyToken } from "./auth.js";
import type { Config } from "./config.js";
import { HostUnavailableError, type EngineHost } from "./host.js";
import type { InstrumentConfig } from "./instruments.js";
import type { StreamHub } from "./stream.js";
import { accountView, marketSummary, orderBook } from "./views.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface AppDeps {
  readonly config: Config;
  readonly host: EngineHost;
  readonly hub: StreamHub;
  readonly instruments: readonly InstrumentConfig[];
  readonly persistence: "postgres" | "memory";
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

const errorBody = (code: string, message: string, details?: unknown): ApiError => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, host, hub, instruments } = deps;
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 16 * 1024,
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
    void reply.headers(SECURITY_HEADERS);
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

  // 503 when the engine can no longer write its log, so the platform restarts it.
  app.get("/api/health", (_request, reply): HealthResponse => {
    const violations = host.exchange.audit().length;
    if (!host.healthy) void reply.status(503);
    return {
      status: host.healthy && violations === 0 ? "ok" : "degraded",
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
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
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

  app.post(
    "/api/orders",
    { config: { rateLimit: { max: 30, timeWindow: "10 seconds" } } },
    async (request, reply) => {
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
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/orders/:id",
    { config: { rateLimit: { max: 30, timeWindow: "10 seconds" } } },
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

  // Streaming --------------------------------------------------------------

  app.get<{ Querystring: { symbol?: string; token?: string } }>(
    "/api/stream",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    (request, reply) => {
      const symbol = instrument(request.query.symbol ?? instruments[0]?.symbol ?? "").symbol;
      // EventSource cannot send headers, so the token travels in the query string.
      const accountId = request.query.token
        ? requireAccount(request, request.query.token)
        : undefined;
      void reply.hijack();
      reply.raw.setHeaders(new Map(Object.entries(SECURITY_HEADERS)));
      hub.attach(reply.raw, symbol, accountId);
    },
  );

  // Web app ----------------------------------------------------------------

  const webRoot = config.WEB_DIST ? path.resolve(config.WEB_DIST) : undefined;
  if (webRoot && existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      setHeaders: (res, filePath) => {
        void res.header(
          "cache-control",
          filePath.includes(`${path.sep}assets${path.sep}`)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    });
    app.get("/*", (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send(errorBody("not_found", "No such endpoint"));
      }
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    });
  }

  // Anything no route claimed (any method, with or without the web app) is a JSON 404.
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody("not_found", "No such endpoint")),
  );

  return app;
}
