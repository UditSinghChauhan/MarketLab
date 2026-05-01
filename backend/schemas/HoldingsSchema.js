const { Schema } = require("mongoose");

const HoldingsSchema = new Schema({
  userId: { type: String, required: true, default: "demo" },
  name: { type: String, required: true },
  qty: { type: Number, required: true, min: 0 },
  avg: { type: Number, required: true, min: 0 },
  price: { type: Number, required: true, min: 0 },
  net: String,
  day: String,
});

HoldingsSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = { HoldingsSchema };
