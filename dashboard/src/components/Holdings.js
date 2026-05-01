import React, { useEffect, useState } from "react";
import axios from "axios";
import { VerticalGraph } from "./VerticalGraph";
import API_BASE_URL from "../config/api";

const formatCurrency = (value) =>
  Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const Holdings = () => {
  const [allHoldings, setAllHoldings] = useState([]);
  const [account, setAccount] = useState(null);

  const loadPortfolio = async () => {
    const [holdingsRes, accountRes] = await Promise.all([
      axios.get(`${API_BASE_URL}/allHoldings`),
      axios.get(`${API_BASE_URL}/account`),
    ]);

    setAllHoldings(holdingsRes.data);
    setAccount(accountRes.data);
  };

  useEffect(() => {
    loadPortfolio();
    window.addEventListener("marketlab:order-filled", loadPortfolio);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadPortfolio);
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

  return (
    <>
      <h3 className="title">Holdings ({allHoldings.length})</h3>

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
      <VerticalGraph data={data} />
    </>
  );
};

export default Holdings;
