const { Schema } = require("mongoose");

const HoldingsSchema = new Schema({
  name: { type: String, required: true, unique: true },
  qty: { type: Number, required: true, min: 0 },
  avg: { type: Number, required: true, min: 0 },
  price: { type: Number, required: true, min: 0 },
  net: String,
  day: String,
});

module.exports = { HoldingsSchema };
