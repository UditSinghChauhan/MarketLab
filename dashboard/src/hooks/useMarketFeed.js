import { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";

const useMarketFeed = () => {
  const [marketFeed, setMarketFeed] = useState([]);

  useEffect(() => {
    let isActive = true;

    const loadMarketFeed = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/market-feed`);

        if (!isActive) {
          return;
        }

        setMarketFeed(res.data.items || []);
        window.dispatchEvent(new Event("marketlab:market-tick"));
      } catch (error) {
        // Keep the last known market snapshot during transient polling failures.
      }
    };

    loadMarketFeed();
    const intervalId = window.setInterval(loadMarketFeed, 5000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  return marketFeed;
};

export default useMarketFeed;
