/**
 * Turns a PostgreSQL connection string into explicit client options.
 *
 * Hosted databases (Neon) hand out strings ending in
 * `?sslmode=require&channel_binding=require`. This module decides what those
 * mean here, instead of leaving it to driver defaults that have changed
 * between versions:
 *
 * - `sslmode=require`, `verify-ca` and `verify-full` all mean TLS **with**
 *   certificate and hostname verification. (libpq's `require` encrypts without
 *   verifying; for a database reached over the internet that is not enough.)
 * - `sslmode=no-verify` encrypts without verifying, for a server with a
 *   self-signed certificate. `sslmode=disable`, or no sslmode, means no TLS:
 *   right for localhost, wrong for anything else.
 * - `channel_binding=require` turns on SCRAM channel binding, which ties the
 *   password exchange to the TLS connection. It needs TLS.
 */

import { readFileSync } from "node:fs";

import type { ClientConfig } from "pg";

const TLS_VERIFIED = new Set(["require", "verify-ca", "verify-full"]);

export class ConnectionStringError extends Error {
  override name = "ConnectionStringError";
}

export function connectionOptions(
  databaseUrl: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ClientConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new ConnectionStringError("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConnectionStringError("DATABASE_URL must start with postgres:// or postgresql://");
  }

  // These three are decided here; everything else is passed through to the driver.
  const sslmode = url.searchParams.get("sslmode") ?? "disable";
  const channelBinding = url.searchParams.get("channel_binding") ?? "prefer";
  const rootCert = url.searchParams.get("sslrootcert");
  for (const name of ["sslmode", "channel_binding", "sslrootcert"]) url.searchParams.delete(name);

  let ssl: ClientConfig["ssl"];
  if (TLS_VERIFIED.has(sslmode)) {
    ssl = { rejectUnauthorized: true, ...(rootCert ? { ca: readFile(rootCert) } : {}) };
  } else if (sslmode === "no-verify") {
    ssl = { rejectUnauthorized: false };
  } else if (sslmode === "disable") {
    ssl = false;
  } else {
    throw new ConnectionStringError(
      `sslmode=${sslmode} is not supported. Use sslmode=require (TLS, certificate verified) or sslmode=disable.`,
    );
  }

  if (!["require", "prefer", "disable"].includes(channelBinding)) {
    throw new ConnectionStringError(
      `channel_binding=${channelBinding} is not supported. Use require, prefer or disable.`,
    );
  }
  if (channelBinding === "require" && ssl === false) {
    throw new ConnectionStringError(
      "channel_binding=require needs TLS. Add sslmode=require to DATABASE_URL.",
    );
  }

  return {
    connectionString: url.toString(),
    ssl,
    // Used when the server offers SCRAM-SHA-256-PLUS (Neon and PostgreSQL 11+ over TLS do).
    enableChannelBinding: channelBinding !== "disable" && ssl !== false,
    // The engine holds one connection for its whole life; notice a dead peer.
    keepAlive: true,
    connectionTimeoutMillis: 15_000,
  };
}
