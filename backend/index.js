require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const { AccountModel } = require("./model/AccountModel");
const { HoldingsModel } = require("./model/HoldingsModel");
const { OrdersModel } = require("./model/OrdersModel");
const { PositionsModel } = require("./model/PositionsModel");

const PORT = process.env.PORT || 3002;
const uri = process.env.MONGO_URL;
const useMemoryStore = !uri || uri.includes("<<");

const app = express();

app.use(cors());
app.use(express.json());

let memoryAccount = {
  name: "Demo Trader",
  openingBalance: 100000,
  cash: 100000,
  save: async () => memoryAccount,
};
let memoryHoldings = [];
let memoryOrders = [];
let memoryPositions = [];

const asyncHandler = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

const formatPercent = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const getDemoAccount = async () => {
  if (useMemoryStore) {
    return memoryAccount;
  }

  let account = await AccountModel.findOne({});

  if (!account) {
    account = await AccountModel.create({
      name: "Demo Trader",
      openingBalance: 100000,
      cash: 100000,
    });
  }

  return account;
};

const enrichHolding = (holding) => {
  const rawHolding =
    typeof holding.toObject === "function" ? holding.toObject() : holding;
  const currentValue = holding.price * holding.qty;
  const investedValue = holding.avg * holding.qty;
  const pnl = currentValue - investedValue;
  const pnlPercent = investedValue > 0 ? (pnl / investedValue) * 100 : 0;

  return {
    ...rawHolding,
    currentValue,
    investedValue,
    pnl,
    net: formatPercent(pnlPercent),
    isLoss: pnl < 0,
  };
};

const getHoldings = async () => {
  if (useMemoryStore) {
    return [...memoryHoldings].sort((a, b) => a.name.localeCompare(b.name));
  }

  return HoldingsModel.find({}).sort({ name: 1 });
};

const findHolding = async (name) => {
  if (useMemoryStore) {
    return memoryHoldings.find((holding) => holding.name === name) || null;
  }

  return HoldingsModel.findOne({ name });
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
    memoryHoldings = memoryHoldings.filter((item) => item.name !== holding.name);
    return;
  }

  return holding.deleteOne();
};

const getOrders = async () => {
  if (useMemoryStore) {
    return [...memoryOrders].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  return OrdersModel.find({}).sort({ createdAt: -1 });
};

const getPositions = async () => {
  if (useMemoryStore) {
    return memoryPositions;
  }

  return PositionsModel.find({});
};

const getSellOrders = async () => {
  if (useMemoryStore) {
    return memoryOrders.filter((order) => order.mode === "SELL");
  }

  return OrdersModel.find({ mode: "SELL" });
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

const getAccountSnapshot = async () => {
  const account = await getDemoAccount();
  const holdings = await getHoldings();
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
  const realizedOrders = await getSellOrders();
  const realizedPnl = realizedOrders.reduce(
    (total, order) => total + (order.realizedPnl || 0),
    0
  );
  const totalValue = account.cash + currentValue;
  const totalPnl = totalValue - account.openingBalance;

  return {
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
  "/account",
  asyncHandler(async (req, res) => {
    res.json(await getAccountSnapshot());
  })
);

app.get(
  "/allHoldings",
  asyncHandler(async (req, res) => {
    const holdings = await getHoldings();
    res.json(holdings.map(enrichHolding));
  })
);

app.get(
  "/allPositions",
  asyncHandler(async (req, res) => {
    res.json(await getPositions());
  })
);

app.get(
  "/allOrders",
  asyncHandler(async (req, res) => {
    const orders = await getOrders();
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

    const orderInput = validation.order;
    const account = await getDemoAccount();
    const holding = await findHolding(orderInput.name);
    let realizedPnl = 0;
    let message = "Order executed";

    if (orderInput.mode === "BUY") {
      if (account.cash < orderInput.value) {
        return res.status(400).json({ message: "Insufficient virtual cash" });
      }

      account.cash -= orderInput.value;

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
      ...orderInput,
      realizedPnl,
      message,
    });

    res.status(201).json({
      message,
      order: savedOrder,
      account: await getAccountSnapshot(),
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
