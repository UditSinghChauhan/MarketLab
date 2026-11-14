/**
 * The order book as a price ladder: asks above, bids below, the spread between.
 * Bars show cumulative depth from the inside out, so the shape of the book reads
 * at a glance. Clicking a level copies its price into the order ticket.
 */

import type { BookLevel, OrderBook, Side } from "@marketlab/contracts";

import { price, qty } from "../lib/format";

const ROWS = 12;

function withCumulative(levels: readonly BookLevel[]) {
  let total = 0;
  return levels.slice(0, ROWS).map((level) => {
    total += level.qty;
    return { ...level, total };
  });
}

export function OrderBookLadder({
  book,
  myPrices,
  onPick,
  compact = false,
}: {
  book: OrderBook | null;
  /** Prices where the user has resting orders, per side. */
  myPrices?: { buy: ReadonlySet<string>; sell: ReadonlySet<string> };
  onPick?: (price: string, side: Side) => void;
  compact?: boolean;
}) {
  if (!book) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted">
        Connecting to the book.
      </div>
    );
  }
  const asks = withCumulative(book.asks);
  const bids = withCumulative(book.bids);
  const max = Math.max(asks.at(-1)?.total ?? 0, bids.at(-1)?.total ?? 0, 1);
  const rowH = compact ? "h-6" : "h-[1.4rem]";

  const row = (level: ReturnType<typeof withCumulative>[number], side: Side) => {
    const isBid = side === "buy";
    const mine = (isBid ? myPrices?.buy : myPrices?.sell)?.has(level.price) ?? false;
    const content = (
      <>
        <span
          aria-hidden="true"
          className={`absolute inset-y-px right-0 ${isBid ? "bg-bid-wash" : "bg-ask-wash"}`}
          style={{ width: `${String((level.total / max) * 100)}%` }}
        />
        <span className={`relative num font-medium ${isBid ? "text-bid" : "text-ask"}`}>
          {mine && (
            <span
              className="mr-1 inline-block size-1.5 rounded-full bg-accent align-middle"
              title="Your order"
            />
          )}
          {price(level.price)}
        </span>
        <span className="relative num text-right text-text">{qty(level.qty)}</span>
        <span className="relative num text-right text-muted">{qty(level.total)}</span>
      </>
    );
    const classes = `relative grid ${rowH} w-full grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3 text-sm`;
    // In the terminal the user is taking the other side: clicking an ask prefills a buy.
    return onPick ? (
      <button
        key={level.price}
        type="button"
        className={`${classes} text-left hover:bg-raised`}
        onClick={() => {
          onPick(level.price, isBid ? "sell" : "buy");
        }}
        aria-label={`${isBid ? "Bid" : "Ask"} ${level.price}, ${String(level.qty)} shares. Use this price.`}
      >
        {content}
      </button>
    ) : (
      <div key={level.price} className={classes}>
        {content}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="grid h-7 shrink-0 grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3 text-2xs text-muted">
        <span>Price</span>
        <span className="text-right">Shares</span>
        <span className="text-right">Total</span>
      </div>
      <div
        className="flex min-h-0 flex-col justify-end overflow-hidden xl:flex-1"
        aria-label="Asks"
      >
        {[...asks].reverse().map((l) => row(l, "sell"))}
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-y border-line bg-raised px-3 text-xs">
        <span className="num text-text">
          Mid <span className="font-medium">{price(book.mid)}</span>
        </span>
        <span className="num text-muted">Spread {price(book.spread)}</span>
      </div>
      <div className="flex min-h-0 flex-col overflow-hidden xl:flex-1" aria-label="Bids">
        {bids.map((l) => row(l, "buy"))}
      </div>
    </div>
  );
}
