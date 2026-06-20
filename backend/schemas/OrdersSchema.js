const { Schema } = require("mongoose");

const OrdersSchema = new Schema({
  userId: { type: String, required: true, default: "demo" },
  name: { type: String, required: true },
  qty: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  mode: { type: String, enum: ["BUY", "SELL"], required: true },
  orderType: { type: String, enum: ["MARKET", "LIMIT", "STOP_LOSS"], default: "MARKET" },
  status: { type: String, default: "EXECUTED" },
  value: { type: Number, required: true },
  realizedPnl: { type: Number, default: 0 },
  limitPrice: { type: Number },
  stopPrice: { type: Number },
  message: String,
  createdAt: { type: Date, default: Date.now },
});

// Index on userId so order history queries never do a full collection scan
OrdersSchema.index({ userId: 1, createdAt: -1 });

module.exports = { OrdersSchema };
