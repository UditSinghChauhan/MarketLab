const { Schema } = require("mongoose");

const WatchlistSchema = new Schema({
  userId: { type: String, required: true, default: "demo" },
  symbol: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

WatchlistSchema.index({ userId: 1, symbol: 1 }, { unique: true });

module.exports = { WatchlistSchema };
