import React from "react";

import Menu from "./Menu";
import useIndices from "../hooks/useIndices";

const formatPoints = (value) =>
  Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

const TopBar = () => {
  const { nifty, sensex } = useIndices();

  return (
    <div className="topbar-container">
      <div className="indices-container">
        <div className="nifty">
          <p className="index">{nifty?.name || "NIFTY 50"}</p>
          <p
            className={
              (nifty?.changePercent || 0) >= 0 ? "index-points up" : "index-points"
            }
          >
            {formatPoints(nifty?.price)}
          </p>
          <p className="percent">{nifty?.percent || "+0.00%"}</p>
        </div>
        <div className="sensex">
          <p className="index">{sensex?.name || "SENSEX"}</p>
          <p
            className={
              (sensex?.changePercent || 0) >= 0
                ? "index-points up"
                : "index-points"
            }
          >
            {formatPoints(sensex?.price)}
          </p>
          <p className="percent">{sensex?.percent || "+0.00%"}</p>
        </div>
      </div>

      <Menu />
    </div>
  );
};

export default TopBar;
