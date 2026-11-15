import pg from "pg";
import { describe, expect, it } from "vitest";

import { ConnectionStringError, connectionOptions } from "./connection.js";

const NEON =
  "postgresql://app_owner:s3cret@ep-cool-name-a1b2c3d4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("connectionOptions", () => {
  it("connects to a Neon string with verified TLS and channel binding", () => {
    const options = connectionOptions(NEON);
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.enableChannelBinding).toBe(true);
    // The two parameters are handled here, so the driver never sees them.
    expect(options.connectionString).toBe(
      "postgresql://app_owner:s3cret@ep-cool-name-a1b2c3d4.ap-southeast-1.aws.neon.tech/neondb",
    );
  });

  it("uses no TLS for a local database", () => {
    const options = connectionOptions("postgres://marketlab:marketlab@localhost:5432/marketlab");
    expect(options.ssl).toBe(false);
    expect(options.enableChannelBinding).toBe(false);
  });

  it.each(["require", "verify-ca", "verify-full"])(
    "sslmode=%s verifies the certificate",
    (mode) => {
      const options = connectionOptions(`postgres://u:p@db.example.com/app?sslmode=${mode}`);
      expect(options.ssl).toEqual({ rejectUnauthorized: true });
      expect(options.enableChannelBinding).toBe(true); // preferred whenever TLS is on
    },
  );

  it("sslmode=no-verify encrypts without verifying, and sslmode=disable turns TLS off", () => {
    expect(connectionOptions("postgres://u:p@h/db?sslmode=no-verify").ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(connectionOptions("postgres://u:p@h/db?sslmode=disable").ssl).toBe(false);
  });

  it("reads a custom root certificate", () => {
    const options = connectionOptions(
      "postgres://u:p@h/db?sslmode=verify-full&sslrootcert=/etc/ca.pem",
      (path) => `contents of ${path}`,
    );
    expect(options.ssl).toEqual({ rejectUnauthorized: true, ca: "contents of /etc/ca.pem" });
    expect(options.connectionString).not.toContain("sslrootcert");
  });

  it("honours channel_binding=disable and keeps other parameters", () => {
    const options = connectionOptions(
      "postgres://u:p@h/db?sslmode=require&channel_binding=disable&application_name=marketlab",
    );
    expect(options.enableChannelBinding).toBe(false);
    expect(options.connectionString).toBe("postgres://u:p@h/db?application_name=marketlab");
  });

  it("explains what to change instead of connecting insecurely", () => {
    expect(() => connectionOptions("postgres://u:p@h/db?sslmode=prefer")).toThrow(
      /sslmode=prefer is not supported. Use sslmode=require/,
    );
    expect(() => connectionOptions("postgres://u:p@h/db?channel_binding=require")).toThrow(
      /needs TLS. Add sslmode=require/,
    );
    expect(() => connectionOptions("postgres://u:p@h/db?channel_binding=maybe")).toThrow(
      ConnectionStringError,
    );
    expect(() => connectionOptions("mysql://u:p@h/db")).toThrow(/must start with postgres/);
    expect(() => connectionOptions("not a url")).toThrow(/not a valid URL/);
  });

  it("never puts the password in an error message", () => {
    try {
      connectionOptions("postgres://u:hunter2@h/db?sslmode=allow");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});

// Against a real server with TLS enabled, reached as "localhost". The CI service
// has no TLS, so this runs where TEST_DATABASE_TLS_URL points at one.
const tlsUrl = process.env.TEST_DATABASE_TLS_URL;
describe.skipIf(!tlsUrl)("connectionOptions against a TLS server", () => {
  const withParams = (params: string) => `${tlsUrl ?? ""}?${params}`;
  const connect = async (url: string) => {
    const client = new pg.Client(connectionOptions(url));
    try {
      await client.connect();
      const { rows } = await client.query<{ ssl: boolean }>(
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
      );
      return rows[0]?.ssl;
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  it("authenticates with channel binding over TLS", async () => {
    expect(await connect(withParams("sslmode=no-verify&channel_binding=require"))).toBe(true);
  });

  it("refuses a server whose certificate does not match the host name", async () => {
    // The same server by address: whatever its certificate says, it is not issued to an IP.
    const byAddress = withParams("sslmode=require").replace("@localhost", "@127.0.0.1");
    await expect(connect(byAddress)).rejects.toThrow(/certificate|altnames|self.signed/i);
    // Without verification the same address connects, so the refusal above was the check.
    expect(await connect(byAddress.replace("sslmode=require", "sslmode=no-verify"))).toBe(true);
  });
});
