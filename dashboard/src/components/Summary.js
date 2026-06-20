import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCompact, getApiErrorMessage } from "../utils/format";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

const Summary = () => {
  const [account, setAccount] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const chartRef = useRef(null);

  const loadAccount = async () => {
    try {
      const [accountRes, historyRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/account`, getAuthConfig()),
        axios.get(`${API_BASE_URL}/portfolio-history`, getAuthConfig()),
      ]);
      setAccount(accountRes.data);
      setHistory(historyRes.data.history || []);
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Unable to load account summary"));
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

  const pnlClass = (account?.totalPnl || 0) >= 0 ? "profit" : "loss";
  const isUp = (account?.totalPnl || 0) >= 0;

  // Build Chart.js dataset from rolling history
  const chartColor = isUp ? "#4caf83" : "#e55353";
  const chartBg = isUp ? "rgba(76,175,131,0.12)" : "rgba(229,83,83,0.10)";

  const chartData = {
    labels: history.map((p) =>
      new Date(p.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    ),
    datasets: [
      {
        data: history.map((p) => p.v),
        borderColor: chartColor,
        backgroundColor: chartBg,
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => ` ₹${Number(ctx.raw).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
        },
      },
    },
    scales: {
      x: {
        display: false,
      },
      y: {
        display: false,
        grace: "5%",
      },
    },
  };

  if (isLoading) {
    return <div className="dashboard-status">Loading portfolio summary...</div>;
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
      <div className="username">
        <h6>Hi, {account?.name || "Demo Trader"}!</h6>
        <hr className="divider" />
      </div>

      {/* Live portfolio value chart */}
      {history.length > 1 && (
        <div className="portfolio-chart-wrap">
          <div className="portfolio-chart-header">
            <span className="portfolio-chart-label">Portfolio Value</span>
            <span className={`portfolio-chart-value ${pnlClass}`}>
              ₹{Number(account?.totalValue || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div className="portfolio-chart-canvas">
            <Line ref={chartRef} data={chartData} options={chartOptions} />
          </div>
        </div>
      )}

      <div className="section">
        <span>
          <p>Equity</p>
        </span>

        <div className="data">
          <div className="first">
            <h3>{formatCompact(account?.cash)}</h3>
            <p>Virtual cash available</p>
          </div>
          <hr />

          <div className="second">
            <p>
              Invested <span>{formatCompact(account?.investedValue)}</span>{" "}
            </p>
            <p>
              Opening balance{" "}
              <span>{formatCompact(account?.openingBalance)}</span>{" "}
            </p>
          </div>
        </div>
        <hr className="divider" />
      </div>

      <div className="section">
        <span>
          <p>Holdings ({account?.holdingsCount || 0})</p>
        </span>

        <div className="data">
          <div className="first">
            <h3 className={pnlClass}>
              {formatCompact(account?.totalPnl)}{" "}
              <small>{formatCompact(account?.totalPnlPercent)}%</small>{" "}
            </h3>
            <p>Total P&L</p>
          </div>
          <hr />

          <div className="second">
            <p>
              Current Value <span>{formatCompact(account?.currentValue)}</span>{" "}
            </p>
            <p>
              Realized P&L <span>{formatCompact(account?.realizedPnl)}</span>{" "}
            </p>
          </div>
        </div>
        <hr className="divider" />
      </div>
    </>
  );
};

export default Summary;
