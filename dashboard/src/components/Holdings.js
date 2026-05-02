import React, { useEffect, useState } from "react";
import axios from "axios";
import { Doughnut } from "react-chartjs-2";
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from "chart.js";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

ChartJS.register(ArcElement, Tooltip, Legend);

const PALETTE = [
  "#4184f3",
  "#ff5722",
  "#48c237",
  "#ffc107",
  "#9c27b0",
  "#00bcd4",
  "#ff9800",
  "#e91e63",
  "#3f51b5",
  "#009688",
];

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

  // Portfolio allocation doughnut — by current market value
  const allocationData = {
    labels: allHoldings.map((h) => h.name),
    datasets: [
      {
        data: allHoldings.map((h) => h.currentValue || 0),
        backgroundColor: PALETTE.slice(0, allHoldings.length),
        borderColor: "#fff",
        borderWidth: 2,
        hoverOffset: 8,
      },
    ],
  };

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: "65%",
    plugins: {
      legend: {
        position: "right",
        labels: {
          padding: 16,
          font: { size: 11 },
          color: "rgb(80, 80, 80)",
          usePointStyle: true,
        },
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const value = ctx.raw || 0;
            const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
            const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
            return ` ₹${Number(value).toLocaleString("en-IN", {
              maximumFractionDigits: 0,
            })} (${pct}%)`;
          },
        },
      },
    },
  };

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
          <h5 className={(account?.unrealizedPnl || 0) >= 0 ? "profit" : "loss"}>
            {formatCurrency(account?.unrealizedPnl)}
          </h5>
          <p>Unrealized P&L</p>
        </div>
      </div>

      {allHoldings.length > 0 && (
        <div className="allocation-section">
          <h4 className="allocation-title">Portfolio Allocation</h4>
          <div className="allocation-chart">
            <Doughnut data={allocationData} options={doughnutOptions} />
          </div>
        </div>
      )}
    </>
  );
};

export default Holdings;
