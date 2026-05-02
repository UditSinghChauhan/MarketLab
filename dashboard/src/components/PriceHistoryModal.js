import React, { useEffect, useState } from "react";
import axios from "axios";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from "chart.js";
import API_BASE_URL from "../config/api";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

const PriceHistoryModal = ({ symbol, currentPrice, onClose }) => {
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadHistory = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/history/${symbol}`);
        setHistory(res.data.history || []);
      } catch {
        setError("Unable to load price history.");
      } finally {
        setIsLoading(false);
      }
    };
    loadHistory();
  }, [symbol]);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const closes = history.map((c) => c.close);
  const isUp = closes.length < 2 || closes[closes.length - 1] >= closes[0];
  const lineColor = isUp ? "rgb(72, 194, 55)" : "rgb(223, 73, 73)";
  const fillColor = isUp ? "rgba(72, 194, 55, 0.08)" : "rgba(223, 73, 73, 0.08)";

  const chartData = {
    labels: history.map((_, i) => {
      if (i === 0) return "Oldest";
      if (i === history.length - 1) return "Now";
      return "";
    }),
    datasets: [
      {
        label: symbol,
        data: closes,
        borderColor: lineColor,
        backgroundColor: fillColor,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.35,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) =>
            `₹ ${Number(ctx.raw).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: "rgb(160,160,160)", font: { size: 10 } },
      },
      y: {
        position: "right",
        grid: { color: "rgba(0,0,0,0.04)" },
        ticks: {
          color: "rgb(160,160,160)",
          font: { size: 10 },
          callback: (v) =>
            `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
        },
      },
    },
    animation: { duration: 300 },
  };

  const priceDiff =
    closes.length >= 2
      ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100
      : 0;

  return (
    <div className="ph-backdrop" onClick={onClose}>
      <div className="ph-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ph-header">
          <div>
            <span className="ph-symbol">{symbol}</span>
            <span className="ph-subtitle">Live price chart · last {history.length} ticks</span>
          </div>
          <div className="ph-price-block">
            <span className="ph-price">
              ₹{Number(currentPrice || 0).toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            {closes.length >= 2 && (
              <span className={priceDiff >= 0 ? "ph-change profit" : "ph-change loss"}>
                {priceDiff >= 0 ? "+" : ""}
                {priceDiff.toFixed(2)}%
              </span>
            )}
          </div>
          <button className="ph-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Chart area */}
        <div className="ph-chart-wrap">
          {isLoading && (
            <div className="ph-placeholder">Loading price history…</div>
          )}
          {error && <div className="ph-placeholder loss">{error}</div>}
          {!isLoading && !error && history.length < 2 && (
            <div className="ph-placeholder">
              Tick data accumulates every 4 s — check back in a moment.
            </div>
          )}
          {!isLoading && !error && history.length >= 2 && (
            <Line data={chartData} options={chartOptions} />
          )}
        </div>

        {/* Footer stats */}
        {!isLoading && history.length >= 2 && (
          <div className="ph-footer">
            <div className="ph-stat">
              <span>Open</span>
              <strong>₹{Number(closes[0]).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong>
            </div>
            <div className="ph-stat">
              <span>High</span>
              <strong>
                ₹{Math.max(...history.map((c) => c.high)).toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </strong>
            </div>
            <div className="ph-stat">
              <span>Low</span>
              <strong>
                ₹{Math.min(...history.map((c) => c.low)).toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </strong>
            </div>
            <div className="ph-stat">
              <span>Current</span>
              <strong className={isUp ? "profit" : "loss"}>
                ₹{Number(closes[closes.length - 1]).toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PriceHistoryModal;
