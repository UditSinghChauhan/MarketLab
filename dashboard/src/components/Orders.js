import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

const Orders = () => {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const loadOrders = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/allOrders`, getAuthConfig());
      setOrders(res.data);
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Unable to load orders"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
    window.addEventListener("marketlab:order-filled", loadOrders);
    window.addEventListener("marketlab:auth-changed", loadOrders);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadOrders);
      window.removeEventListener("marketlab:auth-changed", loadOrders);
    };
  }, []);

  if (isLoading) {
    return <div className="dashboard-status">Loading orders...</div>;
  }

  if (error) {
    return (
      <div className="dashboard-status error-state">
        <strong>{error}</strong>
        <button className="btn btn-blue" onClick={loadOrders}>
          Retry
        </button>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="orders">
        <div className="no-orders">
          <p>You haven't placed any paper orders yet</p>

          <Link to={"/"} className="btn">
            Get started
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <h3 className="title">Orders ({orders.length})</h3>
      <div className="order-table">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Instrument</th>
              <th>Qty.</th>
              <th>Price</th>
              <th>Value</th>
              <th>Status</th>
              <th>Realized P&L</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order._id}>
                <td>{new Date(order.createdAt).toLocaleString()}</td>
                <td className={order.mode === "BUY" ? "profit" : "loss"}>
                  {order.mode}
                </td>
                <td>{order.name}</td>
                <td>{order.qty}</td>
                <td>{formatCurrency(order.price)}</td>
                <td>{formatCurrency(order.value)}</td>
                <td>{order.status}</td>
                <td
                  className={(order.realizedPnl || 0) >= 0 ? "profit" : "loss"}
                >
                  {formatCurrency(order.realizedPnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

export default Orders;
