/**
 * The order book as a price ladder: asks above, bids below, the spread between.
 * Bars show cumulative depth from the inside out, so the shape of the book reads
 * at a glance. Clicking a level copies its price into the order ticket.
 *
 * Keyboard (when levels can be picked): the book is one tab stop. Up and Down
 * move between levels, Home and End jump to the best ask and the best bid, and
 * Enter uses the focused level's price.
 */

import type { BookLevel, OrderBook, Side } from "@marketlab/contracts";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { price, qty } from "../lib/format";
import { Skeleton } from "../ui/Skeleton";

/** Rows a side shows on a phone, and before the column has been measured. */
const ROWS = 12;
/** Levels a side can show at most: the depth the server sends (BOOK_DEPTH). */
const MAX_ROWS = 15;
/** A row is at least this tall where the ladder fills its column (md and up). */
const ROW_PX = 28;
const FILLS_COLUMN = "(min-width: 768px)";

/** A level, by side and distance from the spread (0 is the best price). */
interface Slot {
  readonly side: "ask" | "bid";
  readonly depth: number;
}

function withCumulative(levels: readonly BookLevel[], rows: number) {
  let total = 0;
  return levels.slice(0, rows).map((level) => {
    total += level.qty;
    return { ...level, total };
  });
}

const shares = (n: number) => `${qty(n)} ${n === 1 ? "share" : "shares"}`;

/**
 * How many whole rows fit in one side's half of the column, so the ladder
 * fills it with no empty band. Measured before paint, then on every resize.
 */
function useFittedRows(enabled: boolean) {
  const [element, attach] = useState<HTMLElement | null>(null);
  const [rows, setRows] = useState(ROWS);
  useLayoutEffect(() => {
    if (!enabled || !element) return;
    const measure = () => {
      const fills = typeof window.matchMedia === "function" && matchMedia(FILLS_COLUMN).matches;
      const fit = Math.floor(element.clientHeight / ROW_PX);
      setRows(fills && fit > 0 ? Math.min(MAX_ROWS, fit) : ROWS);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [enabled, element]);
  return { rows, attach };
}

export function OrderBookLadder({
  book,
  myPrices,
  onPick,
  compact = false,
}: {
  book: OrderBook | null;
  /** Prices where the user has resting orders, per side. Marked only on a ladder that picks. */
  myPrices?: { buy: ReadonlySet<string>; sell: ReadonlySet<string> };
  onPick?: (price: string, side: Side) => void;
  compact?: boolean;
}) {
  // The landing page's compact ladder is exactly as tall as its six rows a side.
  const { rows: fittedRows, attach: attachAsks } = useFittedRows(!compact);
  const rows = compact ? 6 : fittedRows;
  // In the terminal, rows share their half of the column exactly. Below md the
  // rows are tap targets, so they get the 24 px WCAG 2.2 asks for.
  const rowH = compact
    ? "h-[26px] shrink-0"
    : "h-6 shrink-0 md:h-auto md:min-h-0 md:max-h-8 md:flex-1";
  const hintId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // The level holding the book's one tab stop; null until the visitor moves it.
  const [active, setActive] = useState<Slot | null>(null);

  if (!book) return <LadderSkeleton rows={rows} rowH={rowH} attach={attachAsks} />;
  const asks = withCumulative(book.asks, rows);
  const bids = withCumulative(book.bids, rows);
  const max = Math.max(asks.at(-1)?.total ?? 0, bids.at(-1)?.total ?? 0, 1);

  // Top to bottom as drawn: the worst ask first, then down through the bids.
  const order: Slot[] = [
    ...asks.map((_, i) => ({ side: "ask" as const, depth: asks.length - 1 - i })),
    ...bids.map((_, depth) => ({ side: "bid" as const, depth })),
  ];
  const bestAsk: Slot | undefined = asks.length > 0 ? { side: "ask", depth: 0 } : order[0];
  const bestBid: Slot | undefined = bids.length > 0 ? { side: "bid", depth: 0 } : order.at(-1);
  // The book moves under a focused row: keep the stop on an existing level.
  const current =
    active && (active.side === "ask" ? asks : bids).length > 0
      ? {
          side: active.side,
          depth: Math.min(active.depth, (active.side === "ask" ? asks : bids).length - 1),
        }
      : bestAsk;
  const keyOf = (slot: Slot) => `${slot.side}-${String(slot.depth)}`;

  const moveTo = (slot: Slot | undefined) => {
    if (!slot) return;
    setActive(slot);
    buttons.current.get(keyOf(slot))?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = current ? order.findIndex((s) => keyOf(s) === keyOf(current)) : -1;
    const targets: Record<string, Slot | undefined> = {
      ArrowUp: order[Math.max(0, at - 1)],
      ArrowDown: order[Math.min(order.length - 1, at + 1)],
      Home: bestAsk,
      End: bestBid,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    moveTo(targets[event.key]);
  };

  const row = (level: ReturnType<typeof withCumulative>[number], slot: Slot) => {
    const isBid = slot.side === "bid";
    const key = keyOf(slot);
    const mine =
      onPick !== undefined && ((isBid ? myPrices?.buy : myPrices?.sell)?.has(level.price) ?? false);
    const priceClass = `relative num font-medium ${isBid ? "text-bid" : "text-ask"}`;
    const label =
      `${isBid ? "Bid" : "Ask"} ₹${price(level.price)}, ${shares(level.qty)}, ${qty(level.total)} total` +
      `${mine ? ", including your order" : ""}. Use this price.`;

    return (
      <div
        key={key}
        className={`relative grid ${rowH} w-full grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3 text-sm ${
          onPick ? "hover:bg-raised has-[:focus-visible]:bg-raised" : ""
        }`}
      >
        {/* Scaled, not resized: the bar changes several times a second and must not cause layout. */}
        <span
          aria-hidden="true"
          className={`absolute inset-y-px inset-x-0 origin-right ${isBid ? "bg-bid-wash" : "bg-ask-wash"}`}
          style={{ transform: `scaleX(${String(level.total / max)})` }}
        />
        {mine && (
          // In the gutter, so the price column stays aligned. The row's label says it in words.
          <span
            aria-hidden="true"
            data-own-order
            className="absolute left-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-accent"
            title="Your order"
          />
        )}
        {onPick ? (
          // The button is the price: its label then contains the text it shows, as
          // speech input needs (WCAG 2.5.3), and its overlay makes the whole row
          // the target. The ring is drawn inside, since the column clips the row.
          // In the terminal the user takes the other side: an ask prefills a buy.
          <button
            ref={(node) => {
              if (node) buttons.current.set(key, node);
              else buttons.current.delete(key);
            }}
            type="button"
            aria-label={label}
            aria-describedby={hintId}
            tabIndex={current && keyOf(current) === key ? 0 : -1}
            className={`${priceClass} text-left outline-none after:absolute after:inset-0 after:z-10 after:rounded-[3px] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent`}
            onFocus={() => {
              setActive(slot);
            }}
            onClick={() => {
              onPick(level.price, isBid ? "sell" : "buy");
            }}
          >
            {price(level.price)}
          </button>
        ) : (
          <span className={priceClass}>{price(level.price)}</span>
        )}
        <span aria-hidden={onPick ? true : undefined} className="relative num text-right text-text">
          {qty(level.qty)}
        </span>
        <span
          aria-hidden={onPick ? true : undefined}
          className="relative num text-right text-muted"
        >
          {qty(level.total)}
        </span>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onPick ? onKeyDown : undefined}>
      {onPick && (
        <span id={hintId} className="sr-only">
          Up and Down move between prices; Home and End jump to the best ask and the best bid.
        </span>
      )}
      <LadderHeader />
      <div
        ref={attachAsks}
        role="group"
        aria-label="Asks"
        className="flex min-h-0 flex-col justify-end overflow-hidden md:flex-1"
      >
        {asks
          .map((l, depth) => ({ l, depth }))
          .reverse()
          .map(({ l, depth }) => row(l, { side: "ask", depth }))}
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
        {bids.map((l, depth) => row(l, { side: "bid", depth }))}
      </div>
    </div>
  );
}

function LadderHeader() {
  return (
    <div className="grid h-7 shrink-0 grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3 text-2xs text-muted">
      <span>Price</span>
      <span className="text-right">Shares</span>
      <span className="text-right">Total</span>
    </div>
  );
}

/** The ladder's frame with still placeholders, in the same rows the live book will fill. */
function LadderSkeleton({
  rows,
  rowH,
  attach,
}: {
  rows: number;
  rowH: string;
  attach: (node: HTMLElement | null) => void;
}) {
  const side = Array.from({ length: rows }, (_, i) => (
    <div key={i} className={`grid ${rowH} w-full grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3`}>
      <Skeleton className="h-2.5 w-14" />
      <Skeleton className="ml-auto h-2.5 w-7" />
      <Skeleton className="ml-auto h-2.5 w-10" />
    </div>
  ));
  return (
    <div className="flex h-full flex-col" role="status" aria-label="Loading the order book">
      <LadderHeader />
      <div
        ref={attach}
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
