import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import API_BASE_URL from "../config/api";

const formatCurrency = (value) =>
  Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const Orders = () => {
  const [orders, setOrders] = useState([]);

  const loadOrders = async () => {
    const res = await axios.get(`${API_BASE_URL}/allOrders`);
    setOrders(res.data);
  };

  useEffect(() => {
    loadOrders();
    window.addEventListener("marketlab:order-filled", loadOrders);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadOrders);
    };
  }, []);

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
