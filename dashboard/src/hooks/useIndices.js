import { useEffect, useState } from "react";
import axios from "axios";
import API_BASE_URL from "../config/api";

const emptyIndices = {
  nifty: { name: "NIFTY 50", price: 0, percent: "+0.00%", changePercent: 0 },
  sensex: { name: "SENSEX", price: 0, percent: "+0.00%", changePercent: 0 },
};

const useIndices = () => {
  const [indices, setIndices] = useState(emptyIndices);

  useEffect(() => {
    let isActive = true;

    const loadIndices = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/indices`);

        if (!isActive) {
          return;
        }

        setIndices(res.data);
      } catch (error) {
        // Preserve the previous index snapshot if polling fails temporarily.
      }
    };

    loadIndices();
    const intervalId = window.setInterval(loadIndices, 5000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  return indices;
};

export default useIndices;
