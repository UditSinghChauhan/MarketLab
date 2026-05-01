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

      const buy = await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: {
          name: "INFY",
          qty: 2,
          price: 1500,
          mode: "BUY",
        },
      });

      assert.equal(buy.response.status, 201);
      assert.equal(buy.payload.account.cash, 97000);

      const sell = await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: {
          name: "INFY",
          qty: 1,
          price: 1600,
          mode: "SELL",
        },
      });

      assert.equal(sell.response.status, 201);
      assert.equal(sell.payload.order.realizedPnl, 100);

      const holdings = await api("/allHoldings", { token: session.token });
      assert.equal(holdings.payload.length, 1);
      assert.equal(holdings.payload[0].qty, 1);

      const account = await api("/account", { token: session.token });
      assert.equal(account.payload.cash, 98600);
      assert.equal(account.payload.realizedPnl, 100);
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
          name: "TCS",
          qty: 1,
          price: 4000,
          mode: "SELL",
        },
      });

      assert.equal(invalidSell.response.status, 400);
      assert.match(invalidSell.payload.message, /Insufficient holdings/i);
    },
  },
  {
    name: "watchlist updates and demo reset restore a clean recruiter state",
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

      await api("/newOrder", {
        token: session.token,
        method: "POST",
        body: {
          name: "INFY",
          qty: 1,
          price: 1500,
          mode: "BUY",
        },
      });

      const reset = await api("/demo/reset", {
        token: session.token,
        method: "POST",
      });
      assert.equal(reset.response.status, 200);
      assert.equal(reset.payload.account.cash, 100000);
      assert.equal(reset.payload.watchlist.length, 9);

      const orders = await api("/allOrders", { token: session.token });
      const holdings = await api("/allHoldings", { token: session.token });
      assert.equal(orders.payload.length, 0);
      assert.equal(holdings.payload.length, 0);
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
