const { Schema } = require("mongoose");

const AccountSchema = new Schema({
  userId: { type: String, required: true, unique: true, default: "demo" },
  name: { type: String, default: "Demo Trader" },
  openingBalance: { type: Number, default: 100000 },
  cash: { type: Number, default: 100000 },
});

module.exports = { AccountSchema };
