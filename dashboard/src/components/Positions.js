import React, { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";

const formatCurrency = (value) =>
  Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const Positions = () => {
  const [positions, setPositions] = useState([]);

  const loadPositions = async () => {
    const res = await axios.get(`${API_BASE_URL}/allPositions`, getAuthConfig());
    setPositions(res.data);
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

  return (
    <>
      <h3 className="title">Positions ({positions.length})</h3>

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
    </>
  );
};

export default Positions;
