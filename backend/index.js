require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { AccountModel } = require("./model/AccountModel");
const { HoldingsModel } = require("./model/HoldingsModel");
const { OrdersModel } = require("./model/OrdersModel");
const { UserModel } = require("./model/UserModel");
const { WatchlistModel } = require("./model/WatchlistModel");
const {
  getAvailableSymbols,
  getIndexFeed,
  getMarketFeed,
  getPriceHistory,
  getQuote,
  upsertSymbol,
} = require("./marketData");

const PORT = process.env.PORT || 3002;
const uri = process.env.MONGO_URL;
const authSecret = process.env.AUTH_SECRET || "marketlab-local-secret";
const useMemoryStore = !uri || uri.includes("<<");

if (!process.env.AUTH_SECRET) {
  console.warn(
    "[WARN] AUTH_SECRET is not set — using insecure default key. Set AUTH_SECRET before any production use."
  );
}

const DEMO_USER = {
  id: "demo",
  name: "Demo Trader",
  email: "demo@marketlab.app",
};
const getDefaultWatchlistSymbols = () => getAvailableSymbols().slice(0, 9);

const app = express();

// CORS — lock to CORS_ORIGIN in production; default to wildcard in dev / memory-store mode.
// Set CORS_ORIGIN=https://your-dashboard.vercel.app before any real deployment.
const corsOrigin = process.env.CORS_ORIGIN || "*";
if (corsOrigin === "*" && !useMemoryStore) {
  console.warn(
    "[WARN] CORS_ORIGIN is not set — all origins are allowed. Set CORS_ORIGIN before any production use."
  );
}
app.use(
  cors({
    origin: corsOrigin,
    credentials: corsOrigin !== "*",
  })
);
app.use(express.json());

// Rate limiting — protects auth endpoints and the order route
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests — please try again in a few minutes" },
  skip: () => useMemoryStore, // skip in memory/test mode so tests aren't affected
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Order rate limit exceeded — please slow down" },
  skip: () => useMemoryStore,
});


let memoryUsers = [];
let memoryAccounts = {};  // populated lazily by getDemoAccount on first request
let memoryHoldings = [];
let memoryOrders = [];
let memoryWatchlists = {
  demo: getDefaultWatchlistSymbols(),
};


const asyncHandler = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

const base64Url = (input) =>
  Buffer.from(JSON.stringify(input)).toString("base64url");

const signToken = (payload) => {
  const encodedPayload = base64Url(payload);
  const signature = crypto
    .createHmac("sha256", authSecret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
};

const verifyToken = (token) => {
  if (!token || !token.includes(".")) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", authSecret)
    .update(encodedPayload)
    .digest("base64url");

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

    if (payload.exp && payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
};

// requireAuth — middleware for routes that must reject unauthenticated callers.
// Unlike the global getRequestUser middleware (which falls back to the demo user
// so the dashboard is always usable), this explicitly returns 401 for mutations
// such as placing orders, modifying the watchlist, and resetting the portfolio.
const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);

  if (!payload?.sub) {
    return res.status(401).json({ message: "Authentication required" });
  }

  next();
};


const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => {
  const passwordHash = crypto
    .pbkdf2Sync(password, salt, 120000, 64, "sha512")
    .toString("hex");

  return { salt, passwordHash };
};

memoryUsers.push({
  ...DEMO_USER,
  ...hashPassword("password123", "marketlab-demo-salt"),
  createdAt: new Date(),
});

const safeUser = (user) => ({
  id: String(user._id || user.id),
  name: user.name,
  email: user.email,
});

const createSession = (user) => {
  const currentUser = safeUser(user);
  const token = signToken({
    sub: currentUser.id,
    name: currentUser.name,
    email: currentUser.email,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
  });

  return { token, user: currentUser };
};

const findUserByEmail = async (email) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (useMemoryStore) {
    return memoryUsers.find((user) => user.email === normalizedEmail) || null;
  }

  return UserModel.findOne({ email: normalizedEmail });
};

const findUserById = async (id) => {
  if (!id || id === "demo") {
    return DEMO_USER;
  }

  if (useMemoryStore) {
    return memoryUsers.find((user) => user.id === id) || null;
  }

  return UserModel.findById(id);
};

const createUser = async ({ name, email, password }) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const { salt, passwordHash } = hashPassword(password);

  if (useMemoryStore) {
    const newUser = {
      id: `user-${Date.now()}`,
      name,
      email: normalizedEmail,
      salt,
      passwordHash,
      createdAt: new Date(),
    };
    memoryUsers.push(newUser);
    return newUser;
  }

  return UserModel.create({
    name,
    email: normalizedEmail,
    salt,
    passwordHash,
  });
};

const getRequestUser = async (req) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);

  if (!payload?.sub) {
    return DEMO_USER;
  }

  const user = await findUserById(payload.sub);
  return user ? safeUser(user) : DEMO_USER;
};

app.use(async (req, res, next) => {
  try {
    req.user = await getRequestUser(req);
    next();
  } catch (error) {
    next(error);
  }
});

const formatPercent = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const getDemoAccount = async (user = DEMO_USER) => {
  const userId = user.id || "demo";

  if (useMemoryStore) {
    if (!memoryAccounts[userId]) {
      memoryAccounts[userId] = {
        userId,
        name: user.name || "Demo Trader",
        openingBalance: 100000,
        cash: 100000 - SEED_INVESTED,
        save: async () => memoryAccounts[userId],
      };
      // Seed a realistic portfolio so the dashboard is never blank on first load
      await seedDemoPortfolio(userId);
    }

    return memoryAccounts[userId];
  }

  let account = await AccountModel.findOne({ userId });

  if (!account) {
    account = await AccountModel.create({
      userId,
      name: user.name || "Demo Trader",
      openingBalance: 100000,
      cash: 100000 - SEED_INVESTED,
    });
    // Seed holdings and orders for first-time users
    await seedDemoPortfolio(userId);
  }

  return account;
};


const enrichHolding = (holding) => {
  const rawHolding =
    typeof holding.toObject === "function" ? holding.toObject() : holding;
  const liveQuote = getQuote(rawHolding.name);
  const marketPrice = liveQuote?.price ?? holding.price;
  const currentValue = marketPrice * holding.qty;
  const investedValue = holding.avg * holding.qty;
  const pnl = currentValue - investedValue;
  const pnlPercent = investedValue > 0 ? (pnl / investedValue) * 100 : 0;

  return {
    ...rawHolding,
    price: marketPrice,
    currentValue,
    investedValue,
    pnl,
    net: formatPercent(pnlPercent),
    day: liveQuote?.day || rawHolding.day || "+0.00%",
    isLoss: pnl < 0,
  };
};

const getHoldings = async (userId) => {
  if (useMemoryStore) {
    return memoryHoldings
      .filter((holding) => holding.userId === userId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return HoldingsModel.find({ userId }).sort({ name: 1 });
};

const findHolding = async (userId, name) => {
  if (useMemoryStore) {
    return (
      memoryHoldings.find(
        (holding) => holding.userId === userId && holding.name === name
      ) || null
    );
  }

  return HoldingsModel.findOne({ userId, name });
};

const createHolding = async (holding) => {
  if (useMemoryStore) {
    const newHolding = { ...holding, _id: `holding-${Date.now()}` };
    memoryHoldings.push(newHolding);
    return newHolding;
  }

  return HoldingsModel.create(holding);
};

const saveHolding = async (holding) => {
  if (useMemoryStore) {
    return holding;
  }

  return holding.save();
};

const deleteHolding = async (holding) => {
  if (useMemoryStore) {
    memoryHoldings = memoryHoldings.filter((item) => item._id !== holding._id);
    return;
  }

  return holding.deleteOne();
};

const getOrders = async (userId) => {
  if (useMemoryStore) {
    return memoryOrders
      .filter((order) => order.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  return OrdersModel.find({ userId }).sort({ createdAt: -1 });
};

const getSellOrders = async (userId) => {
  if (useMemoryStore) {
    return memoryOrders.filter(
      (order) => order.userId === userId && order.mode === "SELL"
    );
  }

  return OrdersModel.find({ userId, mode: "SELL" });
};

const createOrder = async (order) => {
  if (useMemoryStore) {
    const newOrder = {
      ...order,
      _id: `order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      status: order.status || "EXECUTED",
      createdAt: order.createdAt || new Date(),
    };
    memoryOrders.push(newOrder);
    return newOrder;
  }

  return OrdersModel.create(order);
};

const updateOrder = async (orderId, updates) => {
  if (useMemoryStore) {
    const order = memoryOrders.find((o) => o._id === orderId);
    if (order) Object.assign(order, updates);
    return order;
  }
  return OrdersModel.findByIdAndUpdate(orderId, { $set: updates }, { new: true });
};

const deleteOrder = async (orderId, userId) => {
  if (useMemoryStore) {
    const idx = memoryOrders.findIndex((o) => o._id === orderId && o.userId === userId);
    if (idx !== -1) memoryOrders.splice(idx, 1);
    return idx !== -1;
  }
  const result = await OrdersModel.deleteOne({ _id: orderId, userId });
  return result.deletedCount > 0;
};

const getPendingOrders = async () => {
  if (useMemoryStore) {
    return memoryOrders.filter((o) => o.status === "PENDING");
  }
  return OrdersModel.find({ status: "PENDING" });
};

// Limit order evaluation engine — fires every 4 s (matches market tick)
// For each PENDING limit order, checks if the market price has crossed
// the limit price and executes it if so.
const evaluateLimitOrders = async () => {
  try {
    const pendingOrders = await getPendingOrders();
    if (!pendingOrders.length) return;

    const marketMap = getMarketMap();

    for (const order of pendingOrders) {
      const market = marketMap[order.name];
      if (!market) continue;

      const currentPrice = market.price;
      const limitPrice = order.limitPrice;

      const triggered =
        order.orderType === "STOP_LOSS"
          ? currentPrice <= order.stopPrice   // stop-loss: sell when price drops to/below stop
          : order.mode === "BUY"
          ? currentPrice <= limitPrice         // limit buy: execute when market falls to limit
          : currentPrice >= limitPrice;        // limit sell: execute when market rises to limit

      if (!triggered) continue;

      // Re-fetch account and holding to ensure they're still valid
      const fakeUser = { id: order.userId };
      const account = await getDemoAccount(fakeUser);
      const holding = await findHolding(order.userId, order.name);
      const executionValue = currentPrice * order.qty;
      let realizedPnl = 0;

      if (order.mode === "BUY") {
        if (account.cash < executionValue) {
          // Insufficient funds at execution time — cancel the order
          await updateOrder(order._id, { status: "CANCELLED", message: "Insufficient cash at execution" });
          continue;
        }
        account.cash -= executionValue;
        upsertSymbol(order.name, currentPrice);

        if (holding) {
          const totalQty = holding.qty + order.qty;
          const totalCost = holding.avg * holding.qty + executionValue;
          holding.qty = totalQty;
          holding.avg = totalCost / totalQty;
          holding.price = currentPrice;
          holding.day = "+0.00%";
          await saveHolding(holding);
        } else {
          await createHolding({
            userId: order.userId,
            name: order.name,
            qty: order.qty,
            avg: currentPrice,
            price: currentPrice,
            net: "+0.00%",
            day: "+0.00%",
          });
        }
      } else {
        // SELL limit
        if (!holding || holding.qty < order.qty) {
          await updateOrder(order._id, { status: "CANCELLED", message: "Insufficient holdings at execution" });
          continue;
        }
        account.cash += executionValue;
        upsertSymbol(order.name, currentPrice);
        realizedPnl = (currentPrice - holding.avg) * order.qty;
        holding.qty -= order.qty;
        holding.price = currentPrice;
        holding.day = "+0.00%";

        if (holding.qty === 0) {
          await deleteHolding(holding);
        } else {
          await saveHolding(holding);
        }
      }

      await account.save();
      await updateOrder(order._id, {
        status: "EXECUTED",
        price: currentPrice,
        value: executionValue,
        realizedPnl,
        message: `Limit order executed at \u20B9${currentPrice}`,
      });
    }
  } catch (err) {
    // Evaluation errors should never crash the server
    console.error("[limit-order-eval]", err.message);
  }
};

const limitEvalInterval = setInterval(evaluateLimitOrders, 4000);
if (typeof limitEvalInterval.unref === "function") limitEvalInterval.unref();

// Portfolio value history — rolling 60-point buffer per user
// Updated every market tick so the frontend can render a live sparkline
const PORTFOLIO_HISTORY_LENGTH = 60;
const portfolioHistory = {}; // { [userId]: [{ t, v }] }

const recordPortfolioSnapshot = async () => {
  try {
    const activeUserIds = useMemoryStore
      ? [...new Set(memoryAccounts ? Object.keys(memoryAccounts) : [])]
      : (await UserModel.find({}, "id").lean()).map((u) => u.id);

    for (const userId of activeUserIds) {
      const fakeUser = { id: userId };
      const snapshot = await getAccountSnapshot(fakeUser);
      if (!snapshot) continue;

      if (!portfolioHistory[userId]) portfolioHistory[userId] = [];
      portfolioHistory[userId].push({ t: Date.now(), v: snapshot.totalValue });

      if (portfolioHistory[userId].length > PORTFOLIO_HISTORY_LENGTH) {
        portfolioHistory[userId].shift();
      }
    }
  } catch (err) {
    // Never crash the server on snapshot errors
    console.error("[portfolio-snapshot]", err.message);
  }
};

const portfolioSnapshotInterval = setInterval(recordPortfolioSnapshot, 4000);
if (typeof portfolioSnapshotInterval.unref === "function") portfolioSnapshotInterval.unref();


const getWatchlistSymbols = async (userId) => {
  if (useMemoryStore) {
    if (!memoryWatchlists[userId]) {
      memoryWatchlists[userId] = getDefaultWatchlistSymbols();
    }

    return [...memoryWatchlists[userId]];
  }

  let items = await WatchlistModel.find({ userId }).sort({ createdAt: 1 });

  if (!items.length) {
    const defaultSymbols = getDefaultWatchlistSymbols().map((symbol) => ({
      userId,
      symbol,
    }));
    await WatchlistModel.insertMany(defaultSymbols, { ordered: false });
    items = await WatchlistModel.find({ userId }).sort({ createdAt: 1 });
  }

  return items.map((item) => item.symbol);
};

const getWatchlistFeed = async (userId) => {
  const symbols = await getWatchlistSymbols(userId);
  const marketFeed = getMarketFeed();

  return symbols
    .map((symbol) => marketFeed.find((item) => item.name === symbol))
    .filter(Boolean);
};

const addWatchlistSymbol = async (userId, symbol) => {
  if (useMemoryStore) {
    const currentSymbols = await getWatchlistSymbols(userId);

    if (!currentSymbols.includes(symbol)) {
      memoryWatchlists[userId] = [...currentSymbols, symbol];
    }

    return;
  }

  await WatchlistModel.updateOne(
    { userId, symbol },
    { $setOnInsert: { userId, symbol } },
    { upsert: true }
  );
};

const removeWatchlistSymbol = async (userId, symbol) => {
  if (useMemoryStore) {
    const currentSymbols = await getWatchlistSymbols(userId);
    memoryWatchlists[userId] = currentSymbols.filter((item) => item !== symbol);
    return;
  }

  await WatchlistModel.deleteOne({ userId, symbol });
};

const getAccountSnapshot = async (user) => {
  const userId = user.id || "demo";
  const account = await getDemoAccount(user);
  const holdings = await getHoldings(userId);
  const enrichedHoldings = holdings.map(enrichHolding);

  const investedValue = enrichedHoldings.reduce(
    (total, holding) => total + holding.investedValue,
    0
  );
  const currentValue = enrichedHoldings.reduce(
    (total, holding) => total + holding.currentValue,
    0
  );
  const unrealizedPnl = currentValue - investedValue;
  const realizedOrders = await getSellOrders(userId);
  const realizedPnl = realizedOrders.reduce(
    (total, order) => total + (order.realizedPnl || 0),
    0
  );
  const totalValue = account.cash + currentValue;
  const totalPnl = totalValue - account.openingBalance;

  return {
    user,
    name: account.name,
    openingBalance: account.openingBalance,
    cash: account.cash,
    investedValue,
    currentValue,
    unrealizedPnl,
    realizedPnl,
    totalValue,
    totalPnl,
    totalPnlPercent:
      account.openingBalance > 0
        ? (totalPnl / account.openingBalance) * 100
        : 0,
    holdingsCount: enrichedHoldings.length,
  };
};

// Realistic seed data for demo showcase — spans 5 sectors so the
// portfolio allocation chart shows meaningful diversification
const SEED_HOLDINGS = [
  { name: "INFY",       qty: 10, avg: 1520.00 }, // Tech
  { name: "TCS",        qty: 3,  avg: 3150.00 }, // Tech
  { name: "RELIANCE",   qty: 5,  avg: 2090.00 }, // Energy
  { name: "HDFCBANK",   qty: 7,  avg: 1500.00 }, // Banking
  { name: "BHARTIARTL", qty: 15, avg: 535.00  }, // Telecom
];

// Total invested: 15200 + 9450 + 10450 + 10500 + 8025 = 53625
// Starting cash after seeding: 100000 - 53625 = 46375
const SEED_INVESTED = SEED_HOLDINGS.reduce((t, h) => t + h.avg * h.qty, 0);

const SEED_ORDERS = [
  // BUY orders matching each holding
  { name: "INFY",       qty: 10, price: 1520.00, mode: "BUY",  realizedPnl: 0    },
  { name: "TCS",        qty: 3,  price: 3150.00, mode: "BUY",  realizedPnl: 0    },
  { name: "RELIANCE",   qty: 5,  price: 2090.00, mode: "BUY",  realizedPnl: 0    },
  { name: "HDFCBANK",   qty: 7,  price: 1500.00, mode: "BUY",  realizedPnl: 0    },
  { name: "BHARTIARTL", qty: 15, price: 535.00,  mode: "BUY",  realizedPnl: 0    },
  // SELL orders — show realized P&L in Orders and Insights
  { name: "WIPRO",  qty: 5, price: 592.00, mode: "SELL", realizedPnl:  75.00 }, // +75
  { name: "ITC",    qty: 8, price: 218.00, mode: "SELL", realizedPnl: 128.00 }, // +128
];

const seedDemoPortfolio = async (userId) => {
  // Seed holdings
  for (const h of SEED_HOLDINGS) {
    const holding = {
      userId,
      name: h.name,
      qty: h.qty,
      avg: h.avg,
      price: h.avg,
      net: "+0.00%",
      day: "+0.00%",
    };
    await createHolding(holding);
  }

  // Seed orders with staggered timestamps for a realistic order history
  const baseTime = Date.now() - 1000 * 60 * 60 * 3; // 3 hours ago
  for (let i = 0; i < SEED_ORDERS.length; i++) {
    const o = SEED_ORDERS[i];
    const order = {
      userId,
      name: o.name,
      qty: o.qty,
      price: o.price,
      mode: o.mode,
      value: o.qty * o.price,
      realizedPnl: o.realizedPnl,
      message: o.mode === "SELL" ? "Position closed" : "Order executed",
      status: "EXECUTED",
      createdAt: new Date(baseTime + i * 1000 * 60 * 18), // 18 min apart
    };

    if (useMemoryStore) {
      memoryOrders.push({ ...order, _id: `seed-order-${i}-${Date.now()}` });
    } else {
      await OrdersModel.create(order);
    }
  }
};

const resetPortfolio = async (user) => {
  const userId = user.id || "demo";
  const defaultWatchlist = getDefaultWatchlistSymbols();

  if (useMemoryStore) {
    memoryAccounts[userId] = {
      userId,
      name: user.name || "Demo Trader",
      openingBalance: 100000,
      cash: 100000 - SEED_INVESTED,
      save: async () => memoryAccounts[userId],
    };
    memoryHoldings = memoryHoldings.filter((h) => h.userId !== userId);
    memoryOrders   = memoryOrders.filter((o) => o.userId !== userId);
    memoryWatchlists[userId] = defaultWatchlist;
    await seedDemoPortfolio(userId);
    return getAccountSnapshot(user);
  }

  await AccountModel.updateOne(
    { userId },
    {
      $set: {
        userId,
        name: user.name || "Demo Trader",
        openingBalance: 100000,
        cash: 100000 - SEED_INVESTED,
      },
    },
    { upsert: true }
  );
  await HoldingsModel.deleteMany({ userId });
  await OrdersModel.deleteMany({ userId });
  await WatchlistModel.deleteMany({ userId });
  await WatchlistModel.insertMany(
    defaultWatchlist.map((symbol) => ({ userId, symbol })),
    { ordered: false }
  );
  await seedDemoPortfolio(userId);

  return getAccountSnapshot(user);
};


const getDerivedPositions = async (userId) => {
  const holdings = await getHoldings(userId);

  return holdings.map((holding) => {
    const enrichedHolding = enrichHolding(holding);

    return {
      _id: enrichedHolding._id,
      product: "CNC",
      name: enrichedHolding.name,
      qty: enrichedHolding.qty,
      avg: enrichedHolding.avg,
      price: enrichedHolding.price,
      pnl: enrichedHolding.pnl,
      day: enrichedHolding.day,
      isLoss: enrichedHolding.isLoss,
    };
  });
};

const validateOrder = ({ name, qty, price, mode, orderType, limitPrice, stopPrice }) => {
  const normalizedMode = String(mode || "").toUpperCase();
  const normalizedName = String(name || "").trim().toUpperCase();
  const normalizedOrderType = String(orderType || "MARKET").toUpperCase();
  const parsedQty = Number(qty);
  const parsedPrice = Number(price);

  if (!normalizedName) {
    return { error: "Instrument is required" };
  }

  if (!["BUY", "SELL"].includes(normalizedMode)) {
    return { error: "Order mode must be BUY or SELL" };
  }

  if (!["MARKET", "LIMIT", "STOP_LOSS"].includes(normalizedOrderType)) {
    return { error: "Order type must be MARKET, LIMIT, or STOP_LOSS" };
  }

  if (normalizedOrderType === "STOP_LOSS" && normalizedMode !== "SELL") {
    return { error: "Stop-loss orders must be SELL orders" };
  }

  if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
    return { error: "Quantity must be greater than zero" };
  }

  if (!Number.isInteger(parsedQty)) {
    return { error: "Quantity must be a whole number" };
  }

  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    return { error: "Price must be greater than zero" };
  }

  return {
    order: {
      name: normalizedName,
      qty: parsedQty,
      price: parsedPrice,
      mode: normalizedMode,
      orderType: normalizedOrderType,
      limitPrice: limitPrice != null ? Number(limitPrice) : undefined,
      stopPrice: stopPrice != null ? Number(stopPrice) : undefined,
      value: parsedQty * parsedPrice,
    },
  };
};

app.get(
  "/health",
  asyncHandler(async (req, res) => {
    res.json({ status: "ok", service: "MarketLab API" });
  })
);

app.get(
  "/market-feed",
  asyncHandler(async (req, res) => {
    res.json({
      updatedAt: new Date().toISOString(),
      items: getMarketFeed(),
    });
  })
);

app.get(
  "/watchlist",
  asyncHandler(async (req, res) => {
    res.json({
      items: await getWatchlistFeed(req.user.id),
      availableSymbols: getAvailableSymbols(),
    });
  })
);

app.post(
  "/watchlist",
  requireAuth,
  asyncHandler(async (req, res) => {
    const symbol = String(req.body.symbol || "").trim().toUpperCase();

    if (!symbol) {
      return res.status(400).json({ message: "Symbol is required" });
    }

    if (!getAvailableSymbols().includes(symbol)) {
      return res.status(404).json({ message: "Symbol is not available" });
    }

    await addWatchlistSymbol(req.user.id, symbol);
    res.status(201).json({ items: await getWatchlistFeed(req.user.id) });
  })
);

app.delete(
  "/watchlist/:symbol",
  requireAuth,
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol || "").trim().toUpperCase();
    await removeWatchlistSymbol(req.user.id, symbol);
    res.json({ items: await getWatchlistFeed(req.user.id) });
  })
);

app.get(
  "/indices",
  asyncHandler(async (req, res) => {
    res.json(getIndexFeed());
  })
);

// Server-Sent Events — single persistent stream replaces three polling loops
app.get("/market-stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = () => {
    try {
      const payload = JSON.stringify({
        market: getMarketFeed(),
        indices: getIndexFeed(),
      });
      res.write(`data: ${payload}\n\n`);
    } catch {
      // client disconnected
    }
  };

  send();
  const intervalId = setInterval(send, 4000);

  req.on("close", () => {
    clearInterval(intervalId);
  });
});

app.get(
  "/history/:symbol",
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol || "").trim().toUpperCase();

    if (!getAvailableSymbols().includes(symbol)) {
      return res.status(404).json({ message: "Symbol not found" });
    }

    res.json({ symbol, history: getPriceHistory(symbol) });
  })
);

app.get(
  "/portfolio-history",
  asyncHandler(async (req, res) => {
    const userId = req.user?.id || "demo";
    const history = portfolioHistory[userId] || [];
    res.json({ history });
  })
);

app.post(
  "/demo/reset",
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = await resetPortfolio(req.user);
    res.json({
      message: "Demo portfolio reset successfully",
      account,
      watchlist: await getWatchlistFeed(req.user.id),
    });
  })
);

app.post(
  "/auth/signup",
  authLimiter,
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!name || !emailRegex.test(email) || password.length < 6) {
      return res.status(400).json({
        message: "Name, valid email, and 6+ character password are required",
      });
    }

    const existingUser = await findUserByEmail(email);

    if (existingUser) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    const user = await createUser({ name, email, password });
    await getDemoAccount(safeUser(user));
    res.status(201).json(createSession(user));
  })
);

app.post(
  "/auth/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const user = await findUserByEmail(email);

    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const { passwordHash } = hashPassword(password, user.salt);

    if (passwordHash !== user.passwordHash) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    res.json(createSession(user));
  })
);

app.get(
  "/auth/me",
  asyncHandler(async (req, res) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = verifyToken(token);

    if (!payload?.sub) {
      return res.status(401).json({ message: "Session expired" });
    }

    const user = await findUserById(payload.sub);

    if (!user) {
      return res.status(401).json({ message: "Session expired" });
    }

    res.json({ user: safeUser(user) });
  })
);

app.get(
  "/account",
  asyncHandler(async (req, res) => {
    res.json(await getAccountSnapshot(req.user));
  })
);

app.get(
  "/allHoldings",
  asyncHandler(async (req, res) => {
    const holdings = await getHoldings(req.user.id);
    res.json(holdings.map(enrichHolding));
  })
);

app.get(
  "/allPositions",
  asyncHandler(async (req, res) => {
    res.json(await getDerivedPositions(req.user.id));
  })
);

app.get(
  "/allOrders",
  asyncHandler(async (req, res) => {
    const orders = await getOrders(req.user.id);
    res.json(orders);
  })
);

app.post(
  "/newOrder",
  requireAuth,
  orderLimiter,
  asyncHandler(async (req, res) => {
    const validation = validateOrder(req.body);

    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const userId = req.user.id || "demo";
    const orderInput = validation.order;
    const account = await getDemoAccount(req.user);
    const holding = await findHolding(userId, orderInput.name);

    // ── LIMIT ORDER: validate upfront then queue as PENDING ──────────
    if (orderInput.orderType === "LIMIT") {
      const limitPrice = Number(orderInput.limitPrice);

      if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
        return res.status(400).json({ message: "Limit price must be a positive number" });
      }

      if (orderInput.mode === "BUY" && account.cash < limitPrice * orderInput.qty) {
        return res.status(400).json({ message: "Insufficient virtual cash for limit order" });
      }

      if (orderInput.mode === "SELL" && (!holding || holding.qty < orderInput.qty)) {
        return res.status(400).json({ message: "Insufficient holdings for limit order" });
      }

      const pendingOrder = await createOrder({
        userId,
        name: orderInput.name,
        qty: orderInput.qty,
        price: limitPrice,
        limitPrice,
        value: limitPrice * orderInput.qty,
        mode: orderInput.mode,
        orderType: "LIMIT",
        status: "PENDING",
        realizedPnl: 0,
        message: `Limit ${orderInput.mode} @ \u20B9${limitPrice} — waiting for trigger`,
      });

      return res.status(201).json({
        message: pendingOrder.message,
        order: pendingOrder,
        account: await getAccountSnapshot(req.user),
      });
    }

    // ── STOP-LOSS ORDER: validate upfront then queue as PENDING ──────
    if (orderInput.orderType === "STOP_LOSS") {
      const stopPrice = Number(orderInput.stopPrice);

      if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
        return res.status(400).json({ message: "Stop price must be a positive number" });
      }

      if (!holding || holding.qty < orderInput.qty) {
        return res.status(400).json({ message: "Insufficient holdings for stop-loss order" });
      }

      const pendingOrder = await createOrder({
        userId,
        name: orderInput.name,
        qty: orderInput.qty,
        price: stopPrice,
        stopPrice,
        value: stopPrice * orderInput.qty,
        mode: "SELL",
        orderType: "STOP_LOSS",
        status: "PENDING",
        realizedPnl: 0,
        message: `Stop-loss SELL @ ₹${stopPrice} — triggers if price falls to stop`,
      });

      return res.status(201).json({
        message: pendingOrder.message,
        order: pendingOrder,
        account: await getAccountSnapshot(req.user),
      });
    }

    // ── MARKET ORDER: execute immediately (existing behaviour) ───────
    let realizedPnl = 0;
    let message = "Order executed";

    if (orderInput.mode === "BUY") {
      if (account.cash < orderInput.value) {
        return res.status(400).json({ message: "Insufficient virtual cash" });
      }

      account.cash -= orderInput.value;
      upsertSymbol(orderInput.name, orderInput.price);

      if (holding) {
        const totalQty = holding.qty + orderInput.qty;
        const totalCost = holding.avg * holding.qty + orderInput.value;
        holding.qty = totalQty;
        holding.avg = totalCost / totalQty;
        holding.price = orderInput.price;
        holding.day = "+0.00%";
        await saveHolding(holding);
      } else {
        await createHolding({
          userId,
          name: orderInput.name,
          qty: orderInput.qty,
          avg: orderInput.price,
          price: orderInput.price,
          net: "+0.00%",
          day: "+0.00%",
        });
      }
    }

    if (orderInput.mode === "SELL") {
      if (!holding || holding.qty < orderInput.qty) {
        return res.status(400).json({ message: "Insufficient holdings" });
      }

      account.cash += orderInput.value;
      upsertSymbol(orderInput.name, orderInput.price);
      realizedPnl = (orderInput.price - holding.avg) * orderInput.qty;
      holding.qty -= orderInput.qty;
      holding.price = orderInput.price;
      holding.day = "+0.00%";

      if (holding.qty === 0) {
        await deleteHolding(holding);
        message = "Position closed";
      } else {
        await saveHolding(holding);
      }
    }

    await account.save();

    const savedOrder = await createOrder({
      userId,
      ...orderInput,
      orderType: "MARKET",
      realizedPnl,
      message,
    });

    res.status(201).json({
      message,
      order: savedOrder,
      account: await getAccountSnapshot(req.user),
    });
  })
);

app.delete(
  "/orders/:id/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id || "");
    const userId = req.user.id || "demo";

    // Only PENDING orders can be cancelled
    let order;
    if (useMemoryStore) {
      order = memoryOrders.find((o) => o._id === orderId && o.userId === userId);
    } else {
      order = await OrdersModel.findOne({ _id: orderId, userId });
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.status !== "PENDING") {
      return res.status(400).json({ message: "Only pending orders can be cancelled" });
    }

    await updateOrder(orderId, {
      status: "CANCELLED",
      message: "Cancelled by user",
    });

    res.json({ message: "Order cancelled", orderId });
  })
);


const startServer = async () => {
  if (useMemoryStore) {
    return app.listen(PORT, () => {
      console.log(`MarketLab API started on port ${PORT} in memory mode`);
    });
  }

  try {
    await mongoose.connect(uri);
    return app.listen(PORT, () => {
      console.log(`MarketLab API started on port ${PORT}`);
    });
  } catch (error) {
    console.error("Database connection failed", error);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
};
