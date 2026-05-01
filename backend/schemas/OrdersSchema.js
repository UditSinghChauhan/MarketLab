const { Schema } = require("mongoose");

const OrdersSchema = new Schema({
  userId: { type: String, required: true, default: "demo" },
  name: { type: String, required: true },
  qty: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  mode: { type: String, enum: ["BUY", "SELL"], required: true },
  status: { type: String, default: "EXECUTED" },
  value: { type: Number, required: true },
  realizedPnl: { type: Number, default: 0 },
  message: String,
  createdAt: { type: Date, default: Date.now },
});

module.exports = { OrdersSchema };
