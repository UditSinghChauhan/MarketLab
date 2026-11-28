/**
 * A worked example of price-time priority: an incoming buy meets the queue at
 * the best ask and takes orders in the order they arrived.
 */

interface Resting {
  id: number;
  shares: number;
  taken: number;
}

const LEVELS: { price: string; orders: Resting[] }[] = [
  {
    price: "1,250.30",
    orders: [
      { id: 63, shares: 40, taken: 0 },
      { id: 81, shares: 10, taken: 0 },
    ],
  },
  {
    price: "1,250.10",
    orders: [
      { id: 41, shares: 20, taken: 20 },
      { id: 57, shares: 15, taken: 10 },
      { id: 70, shares: 25, taken: 0 },
    ],
  },
];

export function MatchingDiagram() {
  return (
    <figure className="self-center rounded-lg border border-line bg-bg p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <span>Sellers waiting, by price</span>
        <span>Queue: earliest on the left</span>
      </div>
      <div className="space-y-2">
        {LEVELS.map((level, i) => (
          // A narrower price column on a phone leaves the queue room for every chip's minimum.
          <div
            key={level.price}
            className="grid grid-cols-[5.5rem_1fr] items-center gap-3 sm:grid-cols-[6.5rem_1fr]"
          >
            <span
              className={`num text-sm ${i === LEVELS.length - 1 ? "font-semibold text-ask" : "text-muted"}`}
            >
              ₹{level.price}
            </span>
            <div className="flex gap-1.5">
              {level.orders.map((o) => (
                <Chip key={o.id} order={o} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs text-muted">best ask is ₹1,250.10</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <div className="rounded-md border border-bid/30 bg-bid-wash px-4 py-3 text-sm">
        <span className="font-semibold">Incoming:</span> buy 30 shares, limit ₹1,250.30
      </div>

      <figcaption className="mt-5 space-y-1.5 text-sm leading-relaxed text-muted">
        <p>
          The buyer would pay up to ₹1,250.30, but cheaper shares are waiting, so it trades at
          ₹1,250.10 first: all 20 of order 41, which arrived first, then 10 of order 57.
        </p>
        <p>
          Order 57 keeps its last 5 shares and its place at the front of the queue. Nothing trades
          at ₹1,250.30.
        </p>
      </figcaption>
    </figure>
  );
}

function Chip({ order }: { order: Resting }) {
  const fill = order.taken / order.shares;
  // Widths follow the shares, but never below what "#57" over "10/15" needs (52 px).
  return (
    <div
      className="relative min-w-[3.25rem] overflow-hidden rounded border border-line bg-surface px-2 py-1"
      style={{ flexGrow: order.shares, flexBasis: 0 }}
      aria-label={`Order ${String(order.id)}: ${String(order.shares)} shares${
        order.taken > 0 ? `, ${String(order.taken)} bought` : ""
      }`}
    >
      {fill > 0 && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-bid-wash"
          style={{ width: `${String(fill * 100)}%` }}
        />
      )}
      <span className="relative block text-2xs text-muted">#{order.id}</span>
      <span className="num relative block text-sm font-medium">
        {order.taken > 0 ? (
          <>
            <span className="text-bid">{order.taken}</span>
            <span className="text-muted">/{order.shares}</span>
          </>
        ) : (
          order.shares
        )}
      </span>
    </div>
  );
}
