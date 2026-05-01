import React, {
  startTransition,
  useContext,
  useDeferredValue,
  useState,
} from "react";

import GeneralContext from "./GeneralContext";

import { Tooltip, Grow } from "@mui/material";

import {
  BarChartOutlined,
  DeleteOutline,
  KeyboardArrowDown,
  KeyboardArrowUp,
} from "@mui/icons-material";

import { DoughnutChart } from "./DoughnoutChart";
import useMarketFeed from "../hooks/useMarketFeed";
import useWatchlist from "../hooks/useWatchlist";
import { getApiErrorMessage } from "../utils/format";

const WatchList = () => {
  useMarketFeed();
  const [searchTerm, setSearchTerm] = useState("");
  const [symbolToAdd, setSymbolToAdd] = useState("");
  const [error, setError] = useState("");
  const deferredSearch = useDeferredValue(searchTerm);
  const {
    addSymbol,
    availableSymbols,
    error: watchlistError,
    isLoading,
    reloadWatchlist,
    removeSymbol,
    watchlist,
  } = useWatchlist();
  const filteredWatchlist = watchlist.filter((stock) =>
    stock.name.toLowerCase().includes(deferredSearch.trim().toLowerCase())
  );

  const handleAddSymbol = async () => {
    const nextSymbol = symbolToAdd.trim().toUpperCase();

    if (!nextSymbol) {
      return;
    }

    if (!availableSymbols.includes(nextSymbol)) {
      setError("Symbol is not available in the simulator");
      return;
    }

    try {
      await addSymbol(nextSymbol);
      startTransition(() => {
        setSymbolToAdd("");
        setError("");
      });
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Unable to add symbol"));
    }
  };

  const data = {
    labels: filteredWatchlist.map((stock) => stock.name),
    datasets: [
      {
        label: "Price",
        data: filteredWatchlist.map((stock) => stock.price),
        backgroundColor: [
          "rgba(255, 99, 132, 0.5)",
          "rgba(54, 162, 235, 0.5)",
          "rgba(255, 206, 86, 0.5)",
          "rgba(75, 192, 192, 0.5)",
          "rgba(153, 102, 255, 0.5)",
          "rgba(255, 159, 64, 0.5)",
        ],
        borderColor: [
          "rgba(255, 99, 132, 1)",
          "rgba(54, 162, 235, 1)",
          "rgba(255, 206, 86, 1)",
          "rgba(75, 192, 192, 1)",
          "rgba(153, 102, 255, 1)",
          "rgba(255, 159, 64, 1)",
        ],
        borderWidth: 1,
      },
    ],
  };

  return (
    <div className="watchlist-container">
      <div className="search-container">
        <input
          type="text"
          name="search"
          id="search"
          placeholder="Search current watchlist"
          className="search"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
        <span className="counts">
          {filteredWatchlist.length} / {watchlist.length}
        </span>
      </div>

      <div style={{ padding: "12px 14px", borderBottom: "1px solid rgb(235, 234, 234)" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            placeholder="Add symbol"
            value={symbolToAdd}
            list="marketlab-symbols"
            onChange={(event) => setSymbolToAdd(event.target.value)}
            style={{
              flex: 1,
              minHeight: "34px",
              border: "1px solid rgb(221, 221, 221)",
              padding: "0 10px",
            }}
          />
          <button className="btn btn-blue" onClick={handleAddSymbol}>
            Add
          </button>
        </div>
        <datalist id="marketlab-symbols">
          {availableSymbols.map((symbol) => (
            <option value={symbol} key={symbol} />
          ))}
        </datalist>
        {(error || watchlistError) && (
          <p style={{ color: "rgb(223, 73, 73)", fontSize: "0.75rem", marginTop: "8px" }}>
            {error || watchlistError}
          </p>
        )}
        {watchlistError && (
          <button className="link-button" onClick={reloadWatchlist}>
            Retry watchlist
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="panel-status">Loading market watchlist...</div>
      ) : (
        <ul className="list">
          {filteredWatchlist.map((stock) => {
            return (
              <WatchListItem
                stock={stock}
                key={stock.name}
                removeSymbol={removeSymbol}
              />
            );
          })}
          {filteredWatchlist.length === 0 && (
            <li className="panel-status">No symbols match this search.</li>
          )}
        </ul>
      )}

      <DoughnutChart data={data} />
    </div>
  );
};

export default WatchList;

const WatchListItem = ({ stock, removeSymbol }) => {
  const [showWatchlistActions, setShowWatchlistActions] = useState(false);

  return (
    <li
      onMouseEnter={() => setShowWatchlistActions(true)}
      onMouseLeave={() => setShowWatchlistActions(false)}
    >
      <div className="item">
        <p className={stock.isDown ? "down" : "up"}>{stock.name}</p>
        <div className="item-info">
          <span className={stock.isDown ? "down" : "up"}>{stock.percent}</span>
          {stock.isDown ? (
            <KeyboardArrowDown className="down" />
          ) : (
            <KeyboardArrowUp className="up" />
          )}
          <span className={stock.isDown ? "down" : "up"}>{stock.price}</span>
        </div>
      </div>
      {showWatchlistActions && (
        <WatchListActions
          uid={stock.name}
          price={stock.price}
          removeSymbol={removeSymbol}
        />
      )}
    </li>
  );
};

const WatchListActions = ({ uid, price, removeSymbol }) => {
  const generalContext = useContext(GeneralContext);

  const handleBuyClick = () => {
    generalContext.openBuyWindow(uid, price);
  };

  const handleSellClick = () => {
    generalContext.openSellWindow(uid, price);
  };

  const handleRemoveClick = async () => {
    await removeSymbol(uid);
  };

  return (
    <span className="actions">
      <span>
        <Tooltip
          title="Buy (B)"
          placement="top"
          arrow
          TransitionComponent={Grow}
          onClick={handleBuyClick}
        >
          <button className="buy">Buy</button>
        </Tooltip>
        <Tooltip
          title="Sell (S)"
          placement="top"
          arrow
          TransitionComponent={Grow}
          onClick={handleSellClick}
        >
          <button className="sell">Sell</button>
        </Tooltip>
        <Tooltip
          title="Analytics (A)"
          placement="top"
          arrow
          TransitionComponent={Grow}
        >
          <button className="action">
            <BarChartOutlined className="icon" />
          </button>
        </Tooltip>
        <Tooltip
          title="Remove from watchlist"
          placement="top"
          arrow
          TransitionComponent={Grow}
          onClick={handleRemoveClick}
        >
          <button className="action">
            <DeleteOutline className="icon" />
          </button>
        </Tooltip>
      </span>
    </span>
  );
};
