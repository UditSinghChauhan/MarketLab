import React, { useContext, useState } from "react";

import axios from "axios";

import GeneralContext from "./GeneralContext";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

import "./BuyActionWindow.css";

const BuyActionWindow = ({ uid, mode = "BUY", defaultPrice = 0 }) => {
  const generalContext = useContext(GeneralContext);
  const [orderType, setOrderType] = useState("MARKET"); // "MARKET" | "LIMIT"
  const [stockQuantity, setStockQuantity] = useState(1);
  const [stockPrice, setStockPrice] = useState(defaultPrice || 0);
  const [limitPrice, setLimitPrice] = useState(defaultPrice || 0);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isBuyOrder = mode === "BUY";
  const isLimit = orderType === "LIMIT";
  const parsedQuantity = Number(stockQuantity);
  const parsedPrice = Number(isLimit ? limitPrice : stockPrice);
  const orderValue = parsedQuantity * parsedPrice;

  const isInvalidOrder =
    !Number.isInteger(parsedQuantity) ||
    parsedQuantity <= 0 ||
    !Number.isFinite(parsedPrice) ||
    parsedPrice <= 0;

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
        price: isLimit ? parsedPrice : Number(stockPrice),
        mode,
        orderType,
        ...(isLimit && { limitPrice: parsedPrice }),
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

  const orderLabel = isLimit
    ? `${mode} LIMIT`
    : `${mode} MARKET`;

  const limitHint =
    isLimit && isBuyOrder
      ? "Executes when market price falls to or below your limit"
      : isLimit
      ? "Executes when market price rises to or above your limit"
      : null;

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

          {isLimit ? (
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
          ) : (
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

        {limitHint && <p className="limit-hint">{limitHint}</p>}
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
            {isSubmitting
              ? "Placing..."
              : isLimit
              ? `Place ${orderLabel}`
              : mode}
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
