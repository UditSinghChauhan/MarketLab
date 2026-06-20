import React, { useContext, useState } from "react";

import axios from "axios";

import GeneralContext from "./GeneralContext";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

import "./BuyActionWindow.css";

const BuyActionWindow = ({ uid, mode = "BUY", defaultPrice = 0 }) => {
  const generalContext = useContext(GeneralContext);

  // "MARKET" | "LIMIT" | "STOP_LOSS"
  // Stop-loss is only available for SELL orders
  const [orderType, setOrderType] = useState("MARKET");
  const [stockQuantity, setStockQuantity] = useState(1);
  const [stockPrice, setStockPrice] = useState(defaultPrice || 0);
  const [limitPrice, setLimitPrice] = useState(defaultPrice || 0);
  const [stopPrice, setStopPrice] = useState(defaultPrice || 0);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isBuyOrder = mode === "BUY";
  const isLimit = orderType === "LIMIT";
  const isStopLoss = orderType === "STOP_LOSS";
  const parsedQuantity = Number(stockQuantity);

  const activePrice = isLimit
    ? Number(limitPrice)
    : isStopLoss
    ? Number(stopPrice)
    : Number(stockPrice);

  const orderValue = parsedQuantity * activePrice;

  const isInvalidOrder =
    !Number.isInteger(parsedQuantity) ||
    parsedQuantity <= 0 ||
    !Number.isFinite(activePrice) ||
    activePrice <= 0;

  const handleTradeClick = async () => {
    if (isInvalidOrder || isSubmitting) {
      setError("Enter a whole quantity and a price above zero");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const body = {
        name: uid,
        qty: parsedQuantity,
        price: activePrice,
        mode,
        orderType,
        ...(isLimit && { limitPrice: activePrice }),
        ...(isStopLoss && { stopPrice: activePrice }),
      };

      await axios.post(`${API_BASE_URL}/newOrder`, body, getAuthConfig());
      window.dispatchEvent(new Event("marketlab:order-filled"));
      generalContext.closeBuyWindow();
    } catch (err) {
      setError(getApiErrorMessage(err, "Unable to place order"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelClick = () => {
    generalContext.closeBuyWindow();
  };

  const hintText = isLimit && isBuyOrder
    ? "Executes when market price falls to or below your limit"
    : isLimit
    ? "Executes when market price rises to or above your limit"
    : isStopLoss
    ? "Auto-sells if market price falls to or below your stop price — protects downside"
    : null;

  const submitLabel = isSubmitting
    ? "Placing..."
    : isLimit
    ? `Place LIMIT ${mode}`
    : isStopLoss
    ? "Place Stop-Loss"
    : mode;

  return (
    <div className="container" id="buy-window">
      <div className="regular-order">
        <div className="order-header">
          <h4>{`${mode} · ${uid}`}</h4>
          <div className="order-type-toggle">
            <button
              className={`ot-btn ${orderType === "MARKET" ? "ot-active" : ""}`}
              onClick={() => setOrderType("MARKET")}
              type="button"
            >
              Market
            </button>
            <button
              className={`ot-btn ${orderType === "LIMIT" ? "ot-active" : ""}`}
              onClick={() => setOrderType("LIMIT")}
              type="button"
            >
              Limit
            </button>
            {!isBuyOrder && (
              <button
                className={`ot-btn ${orderType === "STOP_LOSS" ? "ot-active" : ""}`}
                onClick={() => setOrderType("STOP_LOSS")}
                type="button"
              >
                Stop-Loss
              </button>
            )}
          </div>
        </div>

        <div className="inputs">
          <fieldset>
            <legend>Qty.</legend>
            <input
              type="number"
              name="qty"
              id="qty"
              min="1"
              onChange={(e) => setStockQuantity(e.target.value)}
              value={stockQuantity}
            />
          </fieldset>

          {isLimit && (
            <fieldset>
              <legend>Limit price</legend>
              <input
                type="number"
                name="limitPrice"
                id="limitPrice"
                min="0"
                step="0.05"
                onChange={(e) => setLimitPrice(e.target.value)}
                value={limitPrice}
              />
            </fieldset>
          )}

          {isStopLoss && (
            <fieldset>
              <legend>Stop price</legend>
              <input
                type="number"
                name="stopPrice"
                id="stopPrice"
                min="0"
                step="0.05"
                onChange={(e) => setStopPrice(e.target.value)}
                value={stopPrice}
              />
            </fieldset>
          )}

          {!isLimit && !isStopLoss && (
            <fieldset>
              <legend>Market price</legend>
              <input
                type="number"
                name="price"
                id="price"
                min="0"
                step="0.05"
                onChange={(e) => setStockPrice(e.target.value)}
                value={stockPrice}
              />
            </fieldset>
          )}
        </div>

        {hintText && <p className="limit-hint">{hintText}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="buttons">
        <span>Order value: Rs. {formatCurrency(orderValue)}</span>
        <div>
          <button
            type="button"
            className={`btn ${isBuyOrder ? "btn-blue" : "btn-sell"}`}
            onClick={handleTradeClick}
            disabled={isInvalidOrder || isSubmitting}
          >
            {submitLabel}
          </button>
          <button type="button" className="btn btn-grey" onClick={handleCancelClick}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default BuyActionWindow;
