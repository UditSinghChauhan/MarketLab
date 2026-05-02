/**
 * useIndices — returns live NIFTY / SENSEX data from the shared SSE stream.
 * No separate HTTP polling — data arrives via the market-stream connection.
 */
import { useMarketStream } from "./useMarketFeed";

const emptyIndices = {
  nifty: { name: "NIFTY 50", price: 0, percent: "+0.00%", changePercent: 0, isDown: false },
  sensex: { name: "SENSEX", price: 0, percent: "+0.00%", changePercent: 0, isDown: false },
};

const useIndices = () => {
  const { indices } = useMarketStream();
  return indices || emptyIndices;
};

export default useIndices;
