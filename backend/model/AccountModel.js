const { model } = require("mongoose");

const { AccountSchema } = require("../schemas/AccountSchema");

const AccountModel = new model("account", AccountSchema);

module.exports = { AccountModel };
