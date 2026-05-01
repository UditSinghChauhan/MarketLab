require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const { AccountModel } = require("./model/AccountModel");
const { HoldingsModel } = require("./model/HoldingsModel");
const { OrdersModel } = require("./model/OrdersModel");
const { UserModel } = require("./model/UserModel");
const { WatchlistModel } = require("./model/WatchlistModel");
const {
  getAvailableSymbols,
  getIndexFeed,
  getMarketFeed,
  getQuote,
  upsertSymbol,
} = require("./marketData");

const PORT = process.env.PORT || 3002;
const uri = process.env.MONGO_URL;
const authSecret = process.env.AUTH_SECRET || "marketlab-local-secret";
const useMemoryStore = !uri || uri.includes("<<");

const DEMO_USER = {
  id: "demo",
  name: "Demo Trader",
  email: "demo@marketlab.app",
};

const app = express();

app.use(cors());
app.use(express.json());

let memoryUsers = [];
let memoryAccounts = {
  demo: {
    userId: "demo",
    name: DEMO_USER.name,
    openingBalance: 100000,
    cash: 100000,
    save: async () => memoryAccounts.demo,
  },
};
let memoryHoldings = [];
let memoryOrders = [];
let memoryWatchlists = {
  demo: getAvailableSymbols().slice(0, 9),
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
        cash: 100000,
        save: async () => memoryAccounts[userId],
      };
    }

    return memoryAccounts[userId];
  }

  let account = await AccountModel.findOne({ userId });

  if (!account) {
    account = await AccountModel.create({
      userId,
      name: user.name || "Demo Trader",
      openingBalance: 100000,
      cash: 100000,
    });
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
      _id: `order-${Date.now()}`,
      status: "EXECUTED",
      createdAt: new Date(),
    };
    memoryOrders.push(newOrder);
    return newOrder;
  }

  return OrdersModel.create(order);
};

const getWatchlistSymbols = async (userId) => {
  if (useMemoryStore) {
    if (!memoryWatchlists[userId]) {
      memoryWatchlists[userId] = getAvailableSymbols().slice(0, 9);
    }

    return [...memoryWatchlists[userId]];
  }

  let items = await WatchlistModel.find({ userId }).sort({ createdAt: 1 });

  if (!items.length) {
    const defaultSymbols = getAvailableSymbols().slice(0, 9).map((symbol) => ({
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

const validateOrder = ({ name, qty, price, mode }) => {
  const normalizedMode = String(mode || "").toUpperCase();
  const normalizedName = String(name || "").trim().toUpperCase();
  const parsedQty = Number(qty);
  const parsedPrice = Number(price);

  if (!normalizedName) {
    return { error: "Instrument is required" };
  }

  if (!["BUY", "SELL"].includes(normalizedMode)) {
    return { error: "Order mode must be BUY or SELL" };
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

app.post(
  "/auth/signup",
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email || password.length < 6) {
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
    res.json({ user: req.user });
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
  asyncHandler(async (req, res) => {
    const validation = validateOrder(req.body);

    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const userId = req.user.id || "demo";
    const orderInput = validation.order;
    const account = await getDemoAccount(req.user);
    const holding = await findHolding(userId, orderInput.name);
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

if (useMemoryStore) {
  app.listen(PORT, () => {
    console.log(`MarketLab API started on port ${PORT} in memory mode`);
  });
} else {
  mongoose
    .connect(uri)
    .then(() => {
      app.listen(PORT, () => {
        console.log(`MarketLab API started on port ${PORT}`);
      });
    })
    .catch((error) => {
      console.error("Database connection failed", error);
      process.exit(1);
    });
}
