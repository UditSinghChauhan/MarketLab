import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";

const formatCurrency = (value) =>
  Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatPercent = (value) =>
  `${Number(value || 0) >= 0 ? "+" : ""}${Number(value || 0).toFixed(2)}%`;

const Apps = () => {
  const [account, setAccount] = useState(null);
  const [holdings, setHoldings] = useState([]);
  const [orders, setOrders] = useState([]);

  const loadInsights = async () => {
    const [accountRes, holdingsRes, ordersRes] = await Promise.all([
      axios.get(`${API_BASE_URL}/account`, getAuthConfig()),
      axios.get(`${API_BASE_URL}/allHoldings`, getAuthConfig()),
      axios.get(`${API_BASE_URL}/allOrders`, getAuthConfig()),
    ]);

    setAccount(accountRes.data);
    setHoldings(holdingsRes.data);
    setOrders(ordersRes.data);
  };

  useEffect(() => {
    loadInsights();
    window.addEventListener("marketlab:order-filled", loadInsights);
    window.addEventListener("marketlab:auth-changed", loadInsights);
    window.addEventListener("marketlab:market-tick", loadInsights);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadInsights);
      window.removeEventListener("marketlab:auth-changed", loadInsights);
      window.removeEventListener("marketlab:market-tick", loadInsights);
    };
  }, []);

  const metrics = useMemo(() => {
    const sellOrders = orders.filter((order) => order.mode === "SELL");
    const winningSells = sellOrders.filter((order) => (order.realizedPnl || 0) > 0);
    const tradedValue = orders.reduce((total, order) => total + (order.value || 0), 0);
    const largestHolding = holdings.reduce(
      (largest, holding) =>
        (holding.currentValue || 0) > (largest.currentValue || 0) ? holding : largest,
      {}
    );
    const exposure =
      account?.totalValue > 0 ? ((account.currentValue || 0) / account.totalValue) * 100 : 0;
    const concentration =
      account?.currentValue > 0
        ? ((largestHolding.currentValue || 0) / account.currentValue) * 100
        : 0;

    return {
      exposure,
      concentration,
      largestHolding,
      tradedValue,
      winRate: sellOrders.length ? (winningSells.length / sellOrders.length) * 100 : 0,
      sellOrdersCount: sellOrders.length,
    };
  }, [account, holdings, orders]);

  return (
    <div className="insights-page">
      <div className="insights-header">
        <div>
          <p className="eyebrow">Recruiter demo console</p>
          <h3>Portfolio Insights</h3>
        </div>
        <span className={(account?.totalPnl || 0) >= 0 ? "profit pill" : "loss pill"}>
          Total P&L {formatCurrency(account?.totalPnl)} ({formatPercent(account?.totalPnlPercent)})
        </span>
      </div>

      <div className="insight-grid">
        <div className="insight-card">
          <span>Account value</span>
          <strong>Rs. {formatCurrency(account?.totalValue)}</strong>
          <p>Cash plus current holdings value.</p>
        </div>
        <div className="insight-card">
          <span>Market exposure</span>
          <strong>{formatPercent(metrics.exposure)}</strong>
          <p>Share of capital currently invested.</p>
        </div>
        <div className="insight-card">
          <span>Sell win rate</span>
          <strong>{formatPercent(metrics.winRate)}</strong>
          <p>{metrics.sellOrdersCount} closed sell order(s).</p>
        </div>
        <div className="insight-card">
          <span>Traded value</span>
          <strong>Rs. {formatCurrency(metrics.tradedValue)}</strong>
          <p>Total paper order flow placed in this session.</p>
        </div>
      </div>

      <div className="insights-split">
        <section>
          <h4>Risk Snapshot</h4>
          <div className="risk-row">
            <span>Largest holding</span>
            <strong>{metrics.largestHolding.name || "No holdings yet"}</strong>
          </div>
          <div className="risk-row">
            <span>Concentration</span>
            <strong>{formatPercent(metrics.concentration)}</strong>
          </div>
          <div className="risk-row">
            <span>Unrealized P&L</span>
            <strong className={(account?.unrealizedPnl || 0) >= 0 ? "profit" : "loss"}>
              Rs. {formatCurrency(account?.unrealizedPnl)}
            </strong>
          </div>
          <div className="risk-row">
            <span>Realized P&L</span>
            <strong className={(account?.realizedPnl || 0) >= 0 ? "profit" : "loss"}>
              Rs. {formatCurrency(account?.realizedPnl)}
            </strong>
          </div>
        </section>

        <section>
          <h4>Demo Proof Points</h4>
          <ul className="proof-list">
            <li>Token-based signup and login with user-scoped portfolios</li>
            <li>BUY/SELL validation for cash, quantity, and holdings</li>
            <li>Live dashboard refresh after executed paper orders</li>
            <li>MongoDB-ready backend with memory mode for local demos</li>
          </ul>
        </section>
      </div>

      <h4 className="journal-title">Trade Journal</h4>
      <div className="order-table">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Instrument</th>
              <th>Qty.</th>
              <th>Price</th>
              <th>Value</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {orders.slice(0, 8).map((order) => (
              <tr key={order._id}>
                <td>{new Date(order.createdAt).toLocaleString()}</td>
                <td className={order.mode === "BUY" ? "profit" : "loss"}>{order.mode}</td>
                <td>{order.name}</td>
                <td>{order.qty}</td>
                <td>{formatCurrency(order.price)}</td>
                <td>{formatCurrency(order.value)}</td>
                <td className={(order.realizedPnl || 0) >= 0 ? "profit" : "loss"}>
                  {order.mode === "SELL"
                    ? `P&L ${formatCurrency(order.realizedPnl)}`
                    : "Open exposure"}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan="7">Place a paper order from the watchlist to populate the journal.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Apps;
