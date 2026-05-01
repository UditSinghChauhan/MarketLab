import { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";
import { getAuthConfig } from "../config/auth";

const useWatchlist = () => {
  const [watchlist, setWatchlist] = useState([]);
  const [availableSymbols, setAvailableSymbols] = useState([]);

  const loadWatchlist = async () => {
    const res = await axios.get(`${API_BASE_URL}/watchlist`, getAuthConfig());
    setWatchlist(res.data.items || []);
    setAvailableSymbols(res.data.availableSymbols || []);
  };

  const addSymbol = async (symbol) => {
    const res = await axios.post(
      `${API_BASE_URL}/watchlist`,
      { symbol },
      getAuthConfig()
    );
    setWatchlist(res.data.items || []);
  };

  const removeSymbol = async (symbol) => {
    const res = await axios.delete(
      `${API_BASE_URL}/watchlist/${symbol}`,
      getAuthConfig()
    );
    setWatchlist(res.data.items || []);
  };

  useEffect(() => {
    loadWatchlist();
    window.addEventListener("marketlab:auth-changed", loadWatchlist);
    window.addEventListener("marketlab:market-tick", loadWatchlist);

    return () => {
      window.removeEventListener("marketlab:auth-changed", loadWatchlist);
      window.removeEventListener("marketlab:market-tick", loadWatchlist);
    };
  }, []);

  return {
    addSymbol,
    availableSymbols,
    removeSymbol,
    watchlist,
  };
};

export default useWatchlist;
