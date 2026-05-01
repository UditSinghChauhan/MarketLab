import React, { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";
import { formatCurrency, getApiErrorMessage } from "../utils/format";

const Positions = () => {
  const [positions, setPositions] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const loadPositions = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/allPositions`, getAuthConfig());
      setPositions(res.data);
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Unable to load positions"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadPositions();
    window.addEventListener("marketlab:order-filled", loadPositions);
    window.addEventListener("marketlab:auth-changed", loadPositions);
    window.addEventListener("marketlab:market-tick", loadPositions);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadPositions);
      window.removeEventListener("marketlab:auth-changed", loadPositions);
      window.removeEventListener("marketlab:market-tick", loadPositions);
    };
  }, []);

  if (isLoading) {
    return <div className="dashboard-status">Loading positions...</div>;
  }

  if (error) {
    return (
      <div className="dashboard-status error-state">
        <strong>{error}</strong>
        <button className="btn btn-blue" onClick={loadPositions}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <h3 className="title">Positions ({positions.length})</h3>

      {positions.length === 0 ? (
        <div className="empty-state">
          Positions appear after you buy a stock from the watchlist.
        </div>
      ) : (
        <div className="order-table">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Instrument</th>
                <th>Qty.</th>
                <th>Avg.</th>
                <th>LTP</th>
                <th>P&L</th>
                <th>Chg.</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((stock) => {
                const profClass = (stock.pnl || 0) >= 0 ? "profit" : "loss";
                const dayClass = stock.isLoss ? "loss" : "profit";

                return (
                  <tr key={stock._id || stock.name}>
                    <td>{stock.product}</td>
                    <td>{stock.name}</td>
                    <td>{stock.qty}</td>
                    <td>{stock.avg.toFixed(2)}</td>
                    <td>{stock.price.toFixed(2)}</td>
                    <td className={profClass}>{formatCurrency(stock.pnl)}</td>
                    <td className={dayClass}>{stock.day}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

export default Positions;
