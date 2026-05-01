const seedSymbols = [
  { name: "INFY", price: 1555.45 },
  { name: "ONGC", price: 116.8 },
  { name: "TCS", price: 3194.8 },
  { name: "KPITTECH", price: 266.45 },
  { name: "QUICKHEAL", price: 308.55 },
  { name: "WIPRO", price: 577.75 },
  { name: "M&M", price: 779.8 },
  { name: "RELIANCE", price: 2112.4 },
  { name: "HUL", price: 512.4 },
  { name: "BHARTIARTL", price: 541.15 },
  { name: "HDFCBANK", price: 1522.35 },
  { name: "HINDUNILVR", price: 2417.4 },
  { name: "ITC", price: 207.9 },
  { name: "SBIN", price: 430.2 },
  { name: "SGBMAY29", price: 4719.0 },
  { name: "TATAPOWER", price: 124.15 },
  { name: "EVEREADY", price: 312.35 },
  { name: "JUBLFOOD", price: 3082.65 },
];

const createInitialSnapshot = () =>
  seedSymbols.map((symbol) => ({
    ...symbol,
    open: symbol.price,
    previousClose: symbol.price,
    changePercent: 0,
    dayPercent: 0,
    isDown: false,
  }));

let marketState = createInitialSnapshot();
let lastUpdatedAt = new Date();

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const roundPrice = (value) => Number(value.toFixed(2));
const roundPercent = (value) => Number(value.toFixed(2));

const formatPercent = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const tickMarket = () => {
  marketState = marketState.map((symbol, index) => {
    const drift = Math.sin(Date.now() / 12000 + index) * 0.0025;
    const noise = (Math.random() - 0.5) * 0.012;
    const nextFactor = 1 + drift + noise;
    const minPrice = symbol.open * 0.9;
    const maxPrice = symbol.open * 1.1;
    const nextPrice = clamp(symbol.price * nextFactor, minPrice, maxPrice);
    const changePercent = ((nextPrice - symbol.previousClose) / symbol.previousClose) * 100;
    const dayPercent = ((nextPrice - symbol.open) / symbol.open) * 100;

    return {
      ...symbol,
      price: roundPrice(nextPrice),
      changePercent: roundPercent(changePercent),
      dayPercent: roundPercent(dayPercent),
      isDown: changePercent < 0,
    };
  });

  lastUpdatedAt = new Date();
};

const marketTicker = setInterval(tickMarket, 4000);

if (typeof marketTicker.unref === "function") {
  marketTicker.unref();
}

const getMarketFeed = () =>
  marketState.map((symbol) => ({
    name: symbol.name,
    price: symbol.price,
    percent: formatPercent(symbol.changePercent),
    changePercent: symbol.changePercent,
    day: formatPercent(symbol.dayPercent),
    dayPercent: symbol.dayPercent,
    isDown: symbol.isDown,
  }));

const getMarketMap = () =>
  marketState.reduce((accumulator, symbol) => {
    accumulator[symbol.name] = {
      price: symbol.price,
      percent: formatPercent(symbol.changePercent),
      changePercent: symbol.changePercent,
      day: formatPercent(symbol.dayPercent),
      dayPercent: symbol.dayPercent,
      isDown: symbol.isDown,
    };
    return accumulator;
  }, {});

const getIndexFeed = () => {
  const watchlist = getMarketFeed().slice(0, 9);
  const aggregate = watchlist.reduce(
    (summary, stock) => {
      summary.price += stock.price;
      summary.change += stock.changePercent;
      return summary;
    },
    { price: 0, change: 0 }
  );

  const niftyPoints = (aggregate.price / watchlist.length) * 10;
  const niftyMove = aggregate.change / watchlist.length;
  const sensexPoints = niftyPoints * 3.7;
  const sensexMove = niftyMove * 0.82;

  return {
    updatedAt: lastUpdatedAt.toISOString(),
    nifty: {
      name: "NIFTY 50",
      price: roundPrice(niftyPoints),
      percent: formatPercent(niftyMove),
      changePercent: roundPercent(niftyMove),
      isDown: niftyMove < 0,
    },
    sensex: {
      name: "SENSEX",
      price: roundPrice(sensexPoints),
      percent: formatPercent(sensexMove),
      changePercent: roundPercent(sensexMove),
      isDown: sensexMove < 0,
    },
  };
};

const getQuote = (symbolName) => getMarketMap()[symbolName] || null;

const getAvailableSymbols = () => marketState.map((symbol) => symbol.name);

const upsertSymbol = (symbolName, fallbackPrice) => {
  const existingSymbol = marketState.find((symbol) => symbol.name === symbolName);

  if (existingSymbol) {
    return existingSymbol;
  }

  const price = roundPrice(Number(fallbackPrice) || 0);
  const newSymbol = {
    name: symbolName,
    price,
    open: price,
    previousClose: price,
    changePercent: 0,
    dayPercent: 0,
    isDown: false,
  };

  marketState.push(newSymbol);
  return newSymbol;
};

module.exports = {
  getAvailableSymbols,
  getIndexFeed,
  getMarketFeed,
  getMarketMap,
  getQuote,
  upsertSymbol,
};
