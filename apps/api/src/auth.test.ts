import { describe, expect, it } from "vitest";

import { issueToken, verifyToken } from "./auth.js";

const SECRET = "s".repeat(40);
const NOW = 1_000_000;
const payload = { aid: "g_abc", sid: 3, exp: NOW + 60_000 };

describe("session tokens", () => {
  it("round-trips a valid token", () => {
    expect(verifyToken(issueToken(payload, SECRET), SECRET, NOW)).toEqual({ ok: true, payload });
  });

  it("rejects a token signed with another secret", () => {
    const token = issueToken(payload, "o".repeat(40));
    expect(verifyToken(token, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload", () => {
    const [, signature] = issueToken(payload, SECRET).split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, aid: "g_other" })).toString(
      "base64url",
    );
    expect(verifyToken(`${forged}.${signature ?? ""}`, SECRET, NOW)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an expired token", () => {
    const token = issueToken({ ...payload, exp: NOW - 1 }, SECRET);
    expect(verifyToken(token, SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it.each(["", "abc", "a.b.c", "!!.??"])("rejects malformed token %j", (token) => {
    expect(verifyToken(token, SECRET, NOW).ok).toBe(false);
  });
});
