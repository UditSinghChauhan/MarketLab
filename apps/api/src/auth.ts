/**
 * Stateless guest session tokens: base64url(JSON payload) + "." + HMAC-SHA256.
 *
 * The token names the account and the market session it belongs to. When the
 * market session rolls over, old tokens stop verifying and the client simply
 * starts a new guest session.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenPayload {
  /** Account id. */
  readonly aid: string;
  /** Market session id. */
  readonly sid: number;
  /** Expiry, epoch milliseconds. */
  readonly exp: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly payload: TokenPayload }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

const sign = (data: string, secret: string): string =>
  createHmac("sha256", secret).update(data).digest("base64url");

export function issueToken(payload: TokenPayload, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data, secret)}`;
}

export function verifyToken(token: string, secret: string, now: number): VerifyResult {
  const [data, signature, extra] = token.split(".");
  if (!data || !signature || extra !== undefined) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(sign(data, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as TokenPayload).aid !== "string" ||
    typeof (payload as TokenPayload).sid !== "number" ||
    typeof (payload as TokenPayload).exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const valid = payload as TokenPayload;
  if (valid.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload: valid };
}
