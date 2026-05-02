/**
 * useMarketFeed — SSE-based market data hook.
 *
 * A single EventSource connection is shared across all components that call
 * this hook (module-level singleton). Each caller gets its own React state
 * slice so components render independently when data arrives.
 *
 * The hook also fires `marketlab:market-tick` on every message so that
 * portfolio components (Holdings, Summary, Apps) continue to re-fetch their
 * server-computed data without modification.
 */
import { useEffect, useState } from "react";
import API_BASE_URL from "../config/api";

// ---------- module-level singleton ----------
let streamSource = null;
const streamListeners = new Set();
let latestSnapshot = { market: [], indices: null };

const getOrCreateStream = () => {
  if (streamSource && streamSource.readyState !== EventSource.CLOSED) {
    return;
  }

  streamSource = new EventSource(`${API_BASE_URL}/market-stream`);

  streamSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      latestSnapshot = data;
      // Notify all subscribed React components
      streamListeners.forEach((fn) => fn({ ...data }));
      // Preserve backward compatibility: portfolio components listen for this
      window.dispatchEvent(new Event("marketlab:market-tick"));
    } catch {
      // ignore parse errors — keep last known state
    }
  };

  streamSource.onerror = () => {
    // EventSource auto-reconnects after a network error — no manual handling needed
  };
};
// -------------------------------------------

/**
 * Returns the full market snapshot `{ market: [...], indices: {...} }`.
 * Use the individual helper hooks below for narrower data access.
 */
const useMarketStream = () => {
  const [snapshot, setSnapshot] = useState(latestSnapshot);

  useEffect(() => {
    streamListeners.add(setSnapshot);
    getOrCreateStream();

    return () => {
      streamListeners.delete(setSnapshot);
    };
  }, []);

  return snapshot;
};

/**
 * Returns the flat market feed array: `[{ name, price, percent, isDown, ... }]`
 */
const useMarketFeed = () => {
  const { market } = useMarketStream();
  return market || [];
};

export { useMarketStream };
export default useMarketFeed;
