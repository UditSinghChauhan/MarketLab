import React, { useEffect, useState } from "react";
import axios from "axios";
import { VerticalGraph } from "./VerticalGraph";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

const Holdings = () => {
  const [allHoldings, setAllHoldings] = useState([]);
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const loadPortfolio = async () => {
    try {
      const [holdingsRes, accountRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/allHoldings`, getAuthConfig()),
        axios.get(`${API_BASE_URL}/account`, getAuthConfig()),
      ]);

      setAllHoldings(holdingsRes.data);
      setAccount(accountRes.data);
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Unable to load holdings"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadPortfolio();
    window.addEventListener("marketlab:order-filled", loadPortfolio);
    window.addEventListener("marketlab:auth-changed", loadPortfolio);
    window.addEventListener("marketlab:market-tick", loadPortfolio);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadPortfolio);
      window.removeEventListener("marketlab:auth-changed", loadPortfolio);
      window.removeEventListener("marketlab:market-tick", loadPortfolio);
    };
  }, []);

  const labels = allHoldings.map((subArray) => subArray["name"]);

  const data = {
    labels,
    datasets: [
      {
        label: "Stock Price",
        data: allHoldings.map((stock) => stock.price),
        backgroundColor: "rgba(255, 99, 132, 0.5)",
      },
    ],
  };

  if (isLoading) {
    return <div className="dashboard-status">Loading holdings...</div>;
  }

  if (error) {
    return (
      <div className="dashboard-status error-state">
        <strong>{error}</strong>
        <button className="btn btn-blue" onClick={loadPortfolio}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <h3 className="title">Holdings ({allHoldings.length})</h3>

      {allHoldings.length === 0 ? (
        <div className="empty-state">
          Buy from the watchlist to create your first live holding.
        </div>
      ) : (
        <div className="order-table">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Qty.</th>
                <th>Avg. cost</th>
                <th>LTP</th>
                <th>Cur. val</th>
                <th>P&L</th>
                <th>Net chg.</th>
                <th>Day chg.</th>
              </tr>
            </thead>

            <tbody>
              {allHoldings.map((stock) => {
                const profClass = stock.pnl >= 0 ? "profit" : "loss";
                const dayClass = stock.isLoss ? "loss" : "profit";

                return (
                  <tr key={stock._id || stock.name}>
                    <td>{stock.name}</td>
                    <td>{stock.qty}</td>
                    <td>{stock.avg.toFixed(2)}</td>
                    <td>{stock.price.toFixed(2)}</td>
                    <td>{formatCurrency(stock.currentValue)}</td>
                    <td className={profClass}>{formatCurrency(stock.pnl)}</td>
                    <td className={profClass}>{stock.net}</td>
                    <td className={dayClass}>{stock.day}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="row">
        <div className="col">
          <h5>{formatCurrency(account?.investedValue)}</h5>
          <p>Total investment</p>
        </div>
        <div className="col">
          <h5>{formatCurrency(account?.currentValue)}</h5>
          <p>Current value</p>
        </div>
        <div className="col">
          <h5>{formatCurrency(account?.unrealizedPnl)}</h5>
          <p>Unrealized P&L</p>
        </div>
      </div>
      {allHoldings.length > 0 && <VerticalGraph data={data} />}
    </>
  );
};

export default Holdings;
