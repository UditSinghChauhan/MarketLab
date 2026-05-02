import React, { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

const Funds = () => {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const loadAccount = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/account`, getAuthConfig());
      setAccount(res.data);
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Unable to load funds"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAccount();
    window.addEventListener("marketlab:order-filled", loadAccount);
    window.addEventListener("marketlab:auth-changed", loadAccount);
    window.addEventListener("marketlab:market-tick", loadAccount);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadAccount);
      window.removeEventListener("marketlab:auth-changed", loadAccount);
      window.removeEventListener("marketlab:market-tick", loadAccount);
    };
  }, []);

  if (isLoading) {
    return <div className="dashboard-status">Loading funds...</div>;
  }

  if (error) {
    return (
      <div className="dashboard-status error-state">
        <strong>{error}</strong>
        <button className="btn btn-blue" onClick={loadAccount}>
          Retry
        </button>
      </div>
    );
  }

  const cashPct =
    account?.totalValue > 0
      ? ((account.cash / account.totalValue) * 100).toFixed(1)
      : "100.0";
  const investedPct =
    account?.totalValue > 0
      ? ((account.currentValue / account.totalValue) * 100).toFixed(1)
      : "0.0";

  return (
    <>
      <h3 className="title">Funds</h3>

      <div className="funds-notice">
        <p>
          This is a <strong>paper trading</strong> account. All figures are
          virtual and simulate real market behaviour.
        </p>
      </div>

      <div className="funds-grid">
        {/* Cash */}
        <div className="funds-card">
          <span className="funds-label">Available cash</span>
          <strong className="funds-value colored">
            ₹{formatCurrency(account?.cash)}
          </strong>
          <span className="funds-pct">{cashPct}% of portfolio</span>
        </div>

        {/* Invested */}
        <div className="funds-card">
          <span className="funds-label">Invested value</span>
          <strong className="funds-value">
            ₹{formatCurrency(account?.investedValue)}
          </strong>
          <span className="funds-pct">{investedPct}% of portfolio</span>
        </div>

        {/* Current holdings */}
        <div className="funds-card">
          <span className="funds-label">Current holdings value</span>
          <strong className="funds-value">
            ₹{formatCurrency(account?.currentValue)}
          </strong>
          <span
            className={`funds-pct ${(account?.unrealizedPnl || 0) >= 0 ? "profit" : "loss"}`}
          >
            Unrealized P&L ₹{formatCurrency(account?.unrealizedPnl)}
          </span>
        </div>

        {/* Total portfolio */}
        <div className="funds-card">
          <span className="funds-label">Total portfolio value</span>
          <strong className="funds-value">
            ₹{formatCurrency(account?.totalValue)}
          </strong>
          <span
            className={`funds-pct ${(account?.totalPnl || 0) >= 0 ? "profit" : "loss"}`}
          >
            Opening ₹{formatCurrency(account?.openingBalance)}
          </span>
        </div>
      </div>

      <div className="funds-breakdown">
        <h4 className="allocation-title">Account Breakdown</h4>
        <div className="funds-row">
          <span>Opening balance</span>
          <strong>₹{formatCurrency(account?.openingBalance)}</strong>
        </div>
        <div className="funds-row">
          <span>Available cash</span>
          <strong className="colored">₹{formatCurrency(account?.cash)}</strong>
        </div>
        <div className="funds-row">
          <span>Invested value (cost basis)</span>
          <strong>₹{formatCurrency(account?.investedValue)}</strong>
        </div>
        <div className="funds-row">
          <span>Unrealized P&L</span>
          <strong className={(account?.unrealizedPnl || 0) >= 0 ? "profit" : "loss"}>
            ₹{formatCurrency(account?.unrealizedPnl)}
          </strong>
        </div>
        <div className="funds-row">
          <span>Realized P&L</span>
          <strong className={(account?.realizedPnl || 0) >= 0 ? "profit" : "loss"}>
            ₹{formatCurrency(account?.realizedPnl)}
          </strong>
        </div>
        <div className="funds-row funds-row-total">
          <span>Total account value</span>
          <strong>₹{formatCurrency(account?.totalValue)}</strong>
        </div>
      </div>
    </>
  );
};

export default Funds;
