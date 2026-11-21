/**
 * The HTTP server, listening before the engine is ready.
 *
 * During a deploy the new instance must answer Render's health checks while it
 * waits for the previous instance to release the command log, and then while it
 * replays the log (docs/adr/0009-deploys-with-a-single-writer.md). Until it is
 * handed the app's handler, every request gets 503; `/api/health` says why,
 * without touching the database. The app then takes over the same server, so
 * the port never closes between the two.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { HealthStarting } from "@marketlab/contracts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Fastify's own default for servers it creates (longer than load balancers' idle timeouts). */
const KEEP_ALIVE_TIMEOUT_MS = 72_000;

export interface StartingServer {
  readonly server: Server;
  /** What `/api/health` gives as the reason while starting. */
  setReason(reason: string): void;
  /** From now on, requests go to `handler` (the app). */
  handOver(handler: Handler): void;
}

const isHealth = (url = "") => url === "/api/health" || url.startsWith("/api/health?");

export function createStartingServer(reason = "waiting for the previous instance"): StartingServer {
  let current = reason;
  const starting: Handler = (req, res) => {
    const body: HealthStarting | { error: { code: string; message: string } } = isHealth(req.url)
      ? { status: "starting", reason: current }
      : { error: { code: "unavailable", message: "The exchange is starting" } };
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "5",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };

  let handler = starting;
  const server = createServer((req, res) => {
    handler(req, res);
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  return {
    server,
    setReason: (next) => {
      current = next;
    },
    handOver: (next) => {
      handler = next;
    },
  };
}

/** Starts listening; resolves with the bound port. */
export function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** Stops accepting connections, destroys every open one, and resolves once closed. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}
