import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, formatPercent, getApiErrorMessage } from "../utils/format";

const Apps = () => {
  const [account, setAccount] = useState(null);
  const [holdings, setHoldings] = useState([]);
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const loadInsights = async () => {
    try {
      const [accountRes, holdingsRes, ordersRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/account`, getAuthConfig()),
        axios.get(`${API_BASE_URL}/allHoldings`, getAuthConfig()),
        axios.get(`${API_BASE_URL}/allOrders`, getAuthConfig()),
      ]);

      setAccount(accountRes.data);
      setHoldings(holdingsRes.data);
      setOrders(ordersRes.data);
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Unable to load insights"));
    } finally {
      setIsLoading(false);
    }
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

  if (isLoading) {
    return <div className="dashboard-status">Loading portfolio insights...</div>;
  }

  if (error) {
    return (
      <div className="dashboard-status error-state">
        <strong>{error}</strong>
        <button className="btn btn-blue" onClick={loadInsights}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="insights-page">
      <div className="insights-header">
        <div>
          <p className="eyebrow">Portfolio Analytics</p>
          <h3>Portfolio Insights</h3>
        </div>
        <span className={(account?.totalPnl || 0) >= 0 ? "profit pill" : "loss pill"}>
          Total P&L {formatCurrency(account?.totalPnl)} ({formatPercent(account?.totalPnlPercent)})
        </span>
      </div>

      <div className="insight-grid">
        <div className="insight-card">
          <span>Account value</span>
          <strong>₹{formatCurrency(account?.totalValue)}</strong>
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
          <strong>₹{formatCurrency(metrics.tradedValue)}</strong>
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
              ₹{formatCurrency(account?.unrealizedPnl)}
            </strong>
          </div>
          <div className="risk-row">
            <span>Realized P&L</span>
            <strong className={(account?.realizedPnl || 0) >= 0 ? "profit" : "loss"}>
              ₹{formatCurrency(account?.realizedPnl)}
            </strong>
          </div>
        </section>

        <section>
          <h4>System Architecture</h4>
          <div className="arch-grid">
            <div className="arch-item">
              <span className="arch-label">Transport</span>
              <span className="arch-value">Server-Sent Events</span>
              <span className="arch-note">1 persistent stream · 4 s tick</span>
            </div>
            <div className="arch-item">
              <span className="arch-label">Auth</span>
              <span className="arch-value">HMAC-SHA256 tokens</span>
              <span className="arch-note">PBKDF2 · 120k iterations · no library</span>
            </div>
            <div className="arch-item">
              <span className="arch-label">Storage</span>
              <span className="arch-value">Dual-mode</span>
              <span className="arch-note">Memory fallback · MongoDB-ready</span>
            </div>
            <div className="arch-item">
              <span className="arch-label">Positions</span>
              <span className="arch-value">Derived on read</span>
              <span className="arch-note">Live quote × holding qty</span>
            </div>
            <div className="arch-item">
              <span className="arch-label">Rate limits</span>
              <span className="arch-value">Auth · Orders</span>
              <span className="arch-note">30 req / 15 min · 30 req / min</span>
            </div>
            <div className="arch-item">
              <span className="arch-label">Tests</span>
              <span className="arch-value">5 / 5 passing</span>
              <span className="arch-note">In-process · no database required</span>
            </div>
          </div>
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
