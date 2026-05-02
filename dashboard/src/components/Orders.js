import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

const statusClass = (status) => {
  if (status === "PENDING") return "order-status pending";
  if (status === "CANCELLED") return "order-status cancelled";
  return "order-status executed";
};

const Orders = () => {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState(null);

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

  // Also refresh on market-tick so PENDING → EXECUTED transitions appear live
  useEffect(() => {
    loadOrders();
    window.addEventListener("marketlab:order-filled", loadOrders);
    window.addEventListener("marketlab:auth-changed", loadOrders);
    window.addEventListener("marketlab:market-tick", loadOrders);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadOrders);
      window.removeEventListener("marketlab:auth-changed", loadOrders);
      window.removeEventListener("marketlab:market-tick", loadOrders);
    };
  }, []);

  const handleCancel = async (orderId) => {
    setCancellingId(orderId);
    try {
      await axios.delete(
        `${API_BASE_URL}/orders/${orderId}/cancel`,
        getAuthConfig()
      );
      await loadOrders();
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not cancel order"));
    } finally {
      setCancellingId(null);
    }
  };

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
              <th>Price / Trigger</th>
              <th>Value</th>
              <th>Status</th>
              <th>Realized P&L</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order._id} className={order.status === "PENDING" ? "row-pending" : ""}>
                <td>{new Date(order.createdAt).toLocaleString()}</td>
                <td>
                  <span className={order.mode === "BUY" ? "profit" : "loss"}>
                    {order.mode}
                  </span>
                  {order.orderType === "LIMIT" && (
                    <span className="order-type-badge">LIMIT</span>
                  )}
                </td>
                <td>{order.name}</td>
                <td>{order.qty}</td>
                <td>
                  {order.orderType === "LIMIT" && order.status === "PENDING"
                    ? `≤ ₹${formatCurrency(order.limitPrice)}`
                    : formatCurrency(order.price)}
                </td>
                <td>{formatCurrency(order.value)}</td>
                <td>
                  <span className={statusClass(order.status)}>
                    {order.status}
                  </span>
                </td>
                <td
                  className={
                    order.mode === "SELL"
                      ? (order.realizedPnl || 0) >= 0
                        ? "profit"
                        : "loss"
                      : ""
                  }
                >
                  {order.mode === "SELL" ? formatCurrency(order.realizedPnl) : "—"}
                </td>
                <td>
                  {order.status === "PENDING" && (
                    <button
                      className="cancel-order-btn"
                      onClick={() => handleCancel(order._id)}
                      disabled={cancellingId === order._id}
                    >
                      {cancellingId === order._id ? "…" : "Cancel"}
                    </button>
                  )}
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
