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

  return (
    <>
      <div className="funds">
        <p>Demo account uses virtual funds for paper trading practice.</p>
        <button className="btn btn-green" disabled title="Fixed demo balance">
          Add funds
        </button>
        <button className="btn btn-blue" disabled title="Withdrawals are disabled in demo mode">
          Withdraw
        </button>
      </div>

      <div className="row">
        <div className="col">
          <span>
            <p>Equity</p>
          </span>

          <div className="table">
            <div className="data">
              <p>Available cash</p>
              <p className="imp colored">{formatCurrency(account?.cash)}</p>
            </div>
            <div className="data">
              <p>Invested value</p>
              <p className="imp">{formatCurrency(account?.investedValue)}</p>
            </div>
            <div className="data">
              <p>Current holdings value</p>
              <p className="imp">{formatCurrency(account?.currentValue)}</p>
            </div>
            <hr />
            <div className="data">
              <p>Opening Balance</p>
              <p>{formatCurrency(account?.openingBalance)}</p>
            </div>
            <div className="data">
              <p>Total account value</p>
              <p>{formatCurrency(account?.totalValue)}</p>
            </div>
            <div className="data">
              <p>Unrealized P&L</p>
              <p>{formatCurrency(account?.unrealizedPnl)}</p>
            </div>
            <div className="data">
              <p>Realized P&L</p>
              <p>{formatCurrency(account?.realizedPnl)}</p>
            </div>
          </div>
        </div>

        <div className="col">
          <div className="commodity">
            <p>Commodity simulation is on the roadmap.</p>
            <button className="btn btn-blue">Coming Soon</button>
          </div>
        </div>
      </div>
    </>
  );
};

export default Funds;
