import React, { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";

const formatCompact = (value) =>
  Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });

const Summary = () => {
  const [account, setAccount] = useState(null);

  const loadAccount = async () => {
    const res = await axios.get(`${API_BASE_URL}/account`);
    setAccount(res.data);
  };

  useEffect(() => {
    loadAccount();
    window.addEventListener("marketlab:order-filled", loadAccount);

    return () => {
      window.removeEventListener("marketlab:order-filled", loadAccount);
    };
  }, []);

  const pnlClass = (account?.totalPnl || 0) >= 0 ? "profit" : "loss";

  return (
    <>
      <div className="username">
        <h6>Hi, {account?.name || "Demo Trader"}!</h6>
        <hr className="divider" />
      </div>

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
