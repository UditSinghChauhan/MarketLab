/**
 * The order book as a price ladder: asks above, bids below, the spread between.
 * Bars show cumulative depth from the inside out, so the shape of the book reads
 * at a glance. Clicking a level copies its price into the order ticket.
 */

import type { BookLevel, OrderBook, Side } from "@marketlab/contracts";

import { price, qty } from "../lib/format";
import { Skeleton } from "../ui/Skeleton";

const ROWS = 12;

function withCumulative(levels: readonly BookLevel[], rows: number) {
  let total = 0;
  return levels.slice(0, rows).map((level) => {
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
  // The landing page's compact ladder is exactly as tall as its six rows a side.
  const rows = compact ? 6 : ROWS;
  // In the terminal, rows share the panel's height (up to a comfortable maximum)
  // so the ladder fills its column instead of leaving a gap above and below.
  // Below md the rows are tap targets, so they get the 24 px WCAG 2.2 asks for.
  const rowH = compact
    ? "h-[26px] shrink-0"
    : "h-6 shrink-0 md:h-auto md:max-h-7 md:min-h-[1.4rem] md:flex-1";
  if (!book) return <LadderSkeleton rows={rows} rowH={rowH} />;
  const asks = withCumulative(book.asks, rows);
  const bids = withCumulative(book.bids, rows);
  const max = Math.max(asks.at(-1)?.total ?? 0, bids.at(-1)?.total ?? 0, 1);

  // Rows are keyed by position, not price: the ladder has fixed slots and the
  // market moves through them, so a price change updates a row in place.
  const row = (level: ReturnType<typeof withCumulative>[number], side: Side, slot: number) => {
    const isBid = side === "buy";
    const mine = (isBid ? myPrices?.buy : myPrices?.sell)?.has(level.price) ?? false;
    const content = (
      <>
        {/* Scaled, not resized: the bar changes several times a second and must not cause layout. */}
        <span
          aria-hidden="true"
          className={`absolute inset-y-px inset-x-0 origin-right ${isBid ? "bg-bid-wash" : "bg-ask-wash"}`}
          style={{ transform: `scaleX(${String(level.total / max)})` }}
        />
        <span className={`relative num font-medium ${isBid ? "text-bid" : "text-ask"}`}>
          {onPick && <span className="sr-only">{isBid ? "Bid " : "Ask "}</span>}
          {mine && (
            <span
              className="mr-1 inline-block size-1.5 rounded-full bg-accent align-middle"
              title="Your order"
            />
          )}
          {price(level.price)}
        </span>
        <span className="relative num text-right text-text">
          {qty(level.qty)}
          {onPick && <span className="sr-only"> shares,</span>}
        </span>
        <span className="relative num text-right text-muted">
          {qty(level.total)}
          {onPick && <span className="sr-only"> in total. Use this price.</span>}
        </span>
      </>
    );
    const classes = `relative grid ${rowH} w-full grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3 text-sm`;
    // In the terminal the user is taking the other side: clicking an ask prefills a buy.
    return onPick ? (
      <button
        key={slot}
        type="button"
        className={`${classes} text-left hover:bg-raised`}
        onClick={() => {
          onPick(level.price, isBid ? "sell" : "buy");
        }}
      >
        {content}
      </button>
    ) : (
      <div key={slot} className={classes}>
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
        role="group"
        aria-label="Asks"
        className="flex min-h-0 flex-col justify-end overflow-hidden md:flex-1"
      >
        {[...asks].reverse().map((l, i) => row(l, "sell", i))}
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-y border-line bg-raised px-3 text-xs">
        <span className="num text-text">
          Mid <span className="font-medium">{price(book.mid)}</span>
        </span>
        <span className="num text-muted">Spread {price(book.spread)}</span>
      </div>
      <div
        role="group"
        aria-label="Bids"
        className="flex min-h-0 flex-col overflow-hidden md:flex-1"
      >
        {bids.map((l, i) => row(l, "buy", i))}
      </div>
    </div>
  );
}

/** The ladder's frame with still placeholders, in the same rows the live book will fill. */
function LadderSkeleton({ rows, rowH }: { rows: number; rowH: string }) {
  const side = Array.from({ length: rows }, (_, i) => (
    <div key={i} className={`grid ${rowH} w-full grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3`}>
      <Skeleton className="h-2.5 w-14" />
      <Skeleton className="ml-auto h-2.5 w-7" />
      <Skeleton className="ml-auto h-2.5 w-10" />
    </div>
  ));
  return (
    <div className="flex h-full flex-col" role="status" aria-label="Loading the order book">
      <div className="grid h-7 shrink-0 grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3 text-2xs text-muted">
        <span>Price</span>
        <span className="text-right">Shares</span>
        <span className="text-right">Total</span>
      </div>
      <div
        aria-hidden="true"
        className="flex min-h-0 flex-col justify-end overflow-hidden md:flex-1"
      >
        {side}
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-y border-line bg-raised px-3 text-xs">
        <span className="text-muted">Mid</span>
        <span className="text-muted">Spread</span>
      </div>
      <div aria-hidden="true" className="flex min-h-0 flex-col overflow-hidden md:flex-1">
        {side}
      </div>
    </div>
  );
}
