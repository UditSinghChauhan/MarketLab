import React, {
  startTransition,
  useContext,
  useDeferredValue,
  useMemo,
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

import { DoughnutChart } from "./DoughnutChart";
import useMarketFeed from "../hooks/useMarketFeed";
import useWatchlist from "../hooks/useWatchlist";
import PriceHistoryModal from "./PriceHistoryModal";
import { getApiErrorMessage } from "../utils/format";

const WatchList = () => {
  const marketFeed = useMarketFeed(); // live prices from SSE — no polling
  const [searchTerm, setSearchTerm] = useState("");
  const [symbolToAdd, setSymbolToAdd] = useState("");
  const [error, setError] = useState("");
  const [historySymbol, setHistorySymbol] = useState(null); // { name, price }
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

  // Build a quick-lookup map from the SSE feed
  const marketMap = useMemo(() => {
    const map = {};
    marketFeed.forEach((item) => {
      map[item.name] = item;
    });
    return map;
  }, [marketFeed]);

  // Merge live SSE prices into the watchlist items (no extra API call)
  const enrichedWatchlist = useMemo(
    () =>
      watchlist.map((item) => ({
        ...item,
        ...(marketMap[item.name] || {}),
      })),
    [watchlist, marketMap]
  );

  const filteredWatchlist = enrichedWatchlist.filter((stock) =>
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

      <div className="wl-add-row">
        <div className="wl-add-inputs">
          <input
            type="text"
            placeholder="Add symbol"
            value={symbolToAdd}
            list="marketlab-symbols"
            onChange={(event) => setSymbolToAdd(event.target.value)}
            className="wl-add-input"
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
          <p className="wl-add-error">{error || watchlistError}</p>
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
          {filteredWatchlist.map((stock) => (
            <WatchListItem
              stock={stock}
              key={stock.name}
              removeSymbol={removeSymbol}
              onAnalytics={() =>
                setHistorySymbol({ name: stock.name, price: stock.price })
              }
            />
          ))}
          {filteredWatchlist.length === 0 && (
            <li className="panel-status">No symbols match this search.</li>
          )}
        </ul>
      )}

      <DoughnutChart data={data} />

      {historySymbol && (
        <PriceHistoryModal
          symbol={historySymbol.name}
          currentPrice={historySymbol.price}
          onClose={() => setHistorySymbol(null)}
        />
      )}
    </div>
  );
};

export default WatchList;

const WatchListItem = ({ stock, removeSymbol, onAnalytics }) => {
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
          onAnalytics={onAnalytics}
        />
      )}
    </li>
  );
};

const WatchListActions = ({ uid, price, removeSymbol, onAnalytics }) => {
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
        <Tooltip title="Buy (B)" placement="top" arrow TransitionComponent={Grow} onClick={handleBuyClick}>
          <button className="buy">Buy</button>
        </Tooltip>
        <Tooltip title="Sell (S)" placement="top" arrow TransitionComponent={Grow} onClick={handleSellClick}>
          <button className="sell">Sell</button>
        </Tooltip>
        <Tooltip title="Price chart" placement="top" arrow TransitionComponent={Grow} onClick={onAnalytics}>
          <button className="action">
            <BarChartOutlined className="icon" />
          </button>
        </Tooltip>
        <Tooltip title="Remove from watchlist" placement="top" arrow TransitionComponent={Grow} onClick={handleRemoveClick}>
          <button className="action">
            <DeleteOutline className="icon" />
          </button>
        </Tooltip>
      </span>
    </span>
  );
};
