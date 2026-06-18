const assert = require("node:assert/strict");

process.env.MONGO_URL = "";
process.env.AUTH_SECRET = "marketlab-test-secret";

const { app } = require("../index");

let baseUrl = "";
let server;

const createUser = async () => {
  const email = `user-${Date.now()}-${Math.random().toString(16).slice(2)}@marketlab.test`;
  const response = await fetch(`${baseUrl}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test Recruiter",
      email,
      password: "password123",
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.ok(body.token);

  return body;
};

const api = async (path, { token, method = "GET", body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();

  return { response, payload };
};

const cases = [
  {
    name: "signup returns a session and auth/me restores the same user",
    run: async () => {
      const session = await createUser();
      const { response, payload } = await api("/auth/me", { token: session.token });

      assert.equal(response.status, 200);
      assert.equal(payload.user.email, session.user.email);
      assert.equal(payload.user.name, session.user.name);

      const expired = await api("/auth/me", { token: "invalid-token" });
      assert.equal(expired.response.status, 401);
      assert.match(expired.payload.message, /Session expired/i);
    },
  },
  {
    name: "buy and sell orders update holdings, account cash, and realized pnl",
    run: async () => {
      const session = await createUser();

      // Read starting cash from the seeded account (may be pre-seeded)
      const startAccount = await api("/account", { token: session.token });
      const startCash = startAccount.payload.cash;

      // Count existing INFY holdings from seed
      const startHoldings = await api("/allHoldings", { token: session.token });
      const existingInfy = startHoldings.payload.find((h) => h.name === "INFY");
      const existingQty = existingInfy ? existingInfy.qty : 0;
      const existingAvg = existingInfy ? existingInfy.avg : 0;

      const BUY_PRICE = 1500;
      const BUY_QTY = 2;
      const buy = await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: { name: "INFY", qty: BUY_QTY, price: BUY_PRICE, mode: "BUY" },
      });

      assert.equal(buy.response.status, 201);
      // Cash should drop by exactly the buy value
      assert.equal(buy.payload.account.cash, startCash - BUY_PRICE * BUY_QTY);

      const SELL_PRICE = 1600;
      const SELL_QTY = 1;

      // Avg cost of the INFY lot after buying into a seeded position
      const totalQty = existingQty + BUY_QTY;
      const avgCost =
        totalQty > 0
          ? (existingAvg * existingQty + BUY_PRICE * BUY_QTY) / totalQty
          : BUY_PRICE;
      const expectedRealizedPnl = Math.round((SELL_PRICE - avgCost) * SELL_QTY * 100) / 100;

      const sell = await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: { name: "INFY", qty: SELL_QTY, price: SELL_PRICE, mode: "SELL" },
      });

      assert.equal(sell.response.status, 201);
      // Verify sign: selling above avg cost => positive realized P&L
      assert.ok(sell.payload.order.realizedPnl > 0, "Expected positive realized P&L on profitable sell");

      const holdings = await api("/allHoldings", { token: session.token });
      const infyHolding = holdings.payload.find((h) => h.name === "INFY");
      assert.ok(infyHolding, "INFY holding should still exist after partial sell");
      assert.equal(infyHolding.qty, existingQty + BUY_QTY - SELL_QTY);

      const account = await api("/account", { token: session.token });
      // Cash after buy + sell = startCash - buyValue + sellValue
      const expectedCash = startCash - BUY_PRICE * BUY_QTY + SELL_PRICE * SELL_QTY;
      assert.equal(account.payload.cash, expectedCash);
      assert.ok(account.payload.realizedPnl >= expectedRealizedPnl - 1);
    },
  },
  {
    name: "invalid orders are rejected for insufficient cash and holdings",
    run: async () => {
      const session = await createUser();

      const tooLarge = await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: {
          name: "TCS",
          qty: 1000,
          price: 5000,
          mode: "BUY",
        },
      });

      assert.equal(tooLarge.response.status, 400);
      assert.match(tooLarge.payload.message, /Insufficient virtual cash/i);

      const invalidSell = await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: {
          name: "HINDUNILVR", // not in seeded holdings
          qty: 1,
          price: 2400,
          mode: "SELL",
        },
      });

      assert.equal(invalidSell.response.status, 400);
      assert.match(invalidSell.payload.message, /Insufficient holdings/i);
    },
  },
  {
    name: "watchlist updates and demo reset restore a clean seeded state",
    run: async () => {
      const session = await createUser();

      const before = await api("/watchlist", { token: session.token });
      assert.equal(before.payload.items.length, 9);

      const addSymbol = await api("/watchlist", {
        token: session.token,
        method: "POST",
        body: { symbol: "SBIN" },
      });
      assert.equal(addSymbol.response.status, 201);
      assert.equal(addSymbol.payload.items.length, 10);

      // Place an additional order
      await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: { name: "ONGC", qty: 5, price: 116, mode: "BUY" },
      });

      const reset = await api("/demo/reset", {
        token: session.token,
        method: "POST",
      });
      assert.equal(reset.response.status, 200);
      // After reset, cash = 100000 - seed invested
      assert.ok(reset.payload.account.cash < 100000, "Cash should reflect seeded holdings after reset");
      assert.equal(reset.payload.watchlist.length, 9);

      // After reset, only seeded orders should remain
      const orders = await api("/allOrders", { token: session.token });
      const holdings = await api("/allHoldings", { token: session.token });
      // Seeded data: 5 holdings, 7 orders
      assert.equal(holdings.payload.length, 5, "Should have exactly 5 seeded holdings after reset");
      assert.equal(orders.payload.length, 7, "Should have exactly 7 seeded orders after reset");
    },
  },
  {
    name: "limit orders are queued as PENDING and can be cancelled",
    run: async () => {
      const session = await createUser();

      // A limit price of 1 is far below any realistic market price,
      // so this order will stay PENDING for the duration of the test.
      const limitPrice = 1;

      const limitOrder = await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: {
          name: "RELIANCE",
          qty: 1,
          price: limitPrice,
          mode: "BUY",
          orderType: "LIMIT",
          limitPrice,
        },
      });

      assert.equal(limitOrder.response.status, 201);
      assert.equal(limitOrder.payload.order.status, "PENDING");
      assert.equal(limitOrder.payload.order.orderType, "LIMIT");
      assert.equal(limitOrder.payload.order.limitPrice, limitPrice);

      // Verify order appears in order list as PENDING
      const orders = await api("/allOrders", { token: session.token });
      const pending = orders.payload.find(
        (o) => o._id === limitOrder.payload.order._id
      );
      assert.ok(pending, "Limit order should appear in order list");
      assert.equal(pending.status, "PENDING");

      // Cancel the pending order
      const cancel = await api(
        `/orders/${limitOrder.payload.order._id}/cancel`,
        { token: session.token, method: "DELETE" }
      );
      assert.equal(cancel.response.status, 200);

      // Verify it is now CANCELLED
      const afterCancel = await api("/allOrders", { token: session.token });
      const cancelled = afterCancel.payload.find(
        (o) => o._id === limitOrder.payload.order._id
      );
      assert.equal(cancelled.status, "CANCELLED");

      // A second cancel attempt on a non-PENDING order must be rejected
      const doubleCancel = await api(
        `/orders/${limitOrder.payload.order._id}/cancel`,
        { token: session.token, method: "DELETE" }
      );
      assert.equal(doubleCancel.response.status, 400);
    },
  },
];

const main = async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  let passed = 0;

  try {
    for (const testCase of cases) {
      await testCase.run();
      passed += 1;
      console.log(`PASS ${testCase.name}`);
    }

    console.log(`\n${passed}/${cases.length} integration checks passed`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
};

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
