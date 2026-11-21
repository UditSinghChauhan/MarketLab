import { expect, test } from "./fixtures";
import { E2E_TOKEN_SECRET } from "./secret";

interface Payload {
  readonly aid: string;
  readonly sid: number;
  readonly exp: number;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A guest token signed as the server signs one (apps/api/src/auth.ts). */
async function signToken(payload: Payload): Promise<string> {
  const encoder = new TextEncoder();
  const data = base64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(E2E_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${base64url(new Uint8Array(signature))}`;
}

/** Decodes a token's payload (the part before the signature). */
const payloadOf = (token: string): Payload =>
  JSON.parse(
    atob((token.split(".")[0] ?? "").replaceAll("-", "+").replaceAll("_", "/")),
  ) as Payload;

// The browser logs each 401 the server answers to the stale token; nothing else may appear.
test.use({ allowConsoleErrors: true });

test("a returning visitor whose session has ended gets a fresh guest account", async ({
  page,
  request,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));

  // This test signs tokens as the server does: one for an existing account in
  // the current session is accepted.
  const opened = (await (await request.post("/api/session")).json()) as {
    accountId: string;
    token: string;
  };
  const { sid: current } = payloadOf(opened.token);
  const exp = Date.now() + 60 * 60_000;
  const signed = await signToken({ aid: opened.accountId, sid: current, exp });
  expect(
    (
      await request.get("/api/account", { headers: { authorization: `Bearer ${signed}` } })
    ).status(),
  ).toBe(200);

  // The visitor's browser still holds a token from the previous session.
  const stale = {
    token: await signToken({ aid: "g_0123456789abcdef", sid: current - 1, exp }),
    accountId: "g_0123456789abcdef",
    expiresAt: exp,
  };
  const refused = await request.get("/api/account", {
    headers: { authorization: `Bearer ${stale.token}` },
  });
  expect(refused.status()).toBe(401);
  expect(await refused.json()).toMatchObject({ error: { code: "session_expired" } });
  await page.addInitScript((saved) => {
    localStorage.setItem("marketlab.session", saved);
  }, JSON.stringify(stale));

  // The terminal notices, opens a fresh guest account in the current session, and trades.
  await page.goto("/terminal/ORBT");
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() => localStorage.getItem("marketlab.session"));
      return saved ? (JSON.parse(saved) as { accountId: string }).accountId : null;
    })
    .not.toBe(stale.accountId);
  const renewed = JSON.parse(
    (await page.evaluate(() => localStorage.getItem("marketlab.session"))) ?? "{}",
  ) as { token: string };
  expect(payloadOf(renewed.token).sid).toBe(current);

  await expect(page.getByRole("button", { name: /Buy 10 ORBT/ })).toBeEnabled();
  await page.getByRole("button", { name: /Buy 10 ORBT/ }).click();
  await expect(page.getByText("Bought 10 ORBT")).toBeVisible();

  expect(problems.filter((p) => !/status of 401/.test(p))).toEqual([]);
});
