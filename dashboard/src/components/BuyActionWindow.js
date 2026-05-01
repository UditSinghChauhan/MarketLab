import React, { useContext, useState } from "react";
import { Link } from "react-router-dom";

import axios from "axios";

import GeneralContext from "./GeneralContext";
import API_BASE_URL from "../config/api";

import "./BuyActionWindow.css";

const BuyActionWindow = ({ uid, mode = "BUY", defaultPrice = 0 }) => {
  const generalContext = useContext(GeneralContext);
  const [stockQuantity, setStockQuantity] = useState(1);
  const [stockPrice, setStockPrice] = useState(defaultPrice || 0);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const orderValue = Number(stockQuantity || 0) * Number(stockPrice || 0);
  const isBuyOrder = mode === "BUY";

  const handleTradeClick = async () => {
    setIsSubmitting(true);
    setError("");

    try {
      await axios.post(`${API_BASE_URL}/newOrder`, {
        name: uid,
        qty: Number(stockQuantity),
        price: Number(stockPrice),
        mode,
      });

      window.dispatchEvent(new Event("marketlab:order-filled"));
      generalContext.closeBuyWindow();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to place order");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelClick = () => {
    generalContext.closeBuyWindow();
  };

  return (
    <div className="container" id="buy-window" draggable="true">
      <div className="regular-order">
        <h4>{`${mode} ${uid}`}</h4>
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
          <fieldset>
            <legend>Price</legend>
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
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="buttons">
        <span>Order value: Rs. {orderValue.toFixed(2)}</span>
        <div>
          <Link
            className={`btn ${isBuyOrder ? "btn-blue" : "btn-grey"}`}
            onClick={handleTradeClick}
          >
            {isSubmitting ? "Placing..." : mode}
          </Link>
          <Link to="" className="btn btn-grey" onClick={handleCancelClick}>
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
};

export default BuyActionWindow;
