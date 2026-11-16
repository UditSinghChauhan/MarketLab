import type { TradePrint } from "@marketlab/contracts";

import { price, qty, time } from "../lib/format";
import { Skeleton } from "../ui/Skeleton";

/** The last trades, newest first. Colour shows who crossed the spread: green buyers, red sellers. */
export function TradeTape({
  trades,
  highlight,
  loading = false,
}: {
  trades: readonly TradePrint[];
  highlight?: ReadonlySet<number>;
  /** True until the stream has delivered the tape. */
  loading?: boolean;
}) {
  if (trades.length === 0 && !loading) {
    return <p className="p-3 text-sm text-muted">No trades yet in this session.</p>;
  }
  return (
    <table className="w-full table-fixed text-sm" aria-busy={loading}>
      <caption className="sr-only">Recent trades</caption>
      <thead className="sticky top-0 z-10 bg-surface text-2xs text-muted">
        <tr className="h-7">
          <th scope="col" className="w-[38%] px-3 text-left font-normal">
            Price
          </th>
          <th scope="col" className="px-3 text-right font-normal">
            Shares
          </th>
          <th scope="col" className="px-3 text-right font-normal">
            Time
          </th>
        </tr>
      </thead>
      {/* New trades push older ones down: that movement is the feed, not a layout shift. */}
      <tbody data-live-feed>
        {trades.length === 0 &&
          Array.from({ length: 12 }, (_, i) => (
            <tr key={i} className="h-6" aria-hidden="true">
              <td className="px-3">
                <Skeleton className="h-2.5 w-14" />
              </td>
              <td className="px-3">
                <Skeleton className="ml-auto h-2.5 w-6" />
              </td>
              <td className="px-3">
                <Skeleton className="ml-auto h-2.5 w-12" />
              </td>
            </tr>
          ))}
        {trades.map((t, i) => (
          <tr
            key={t.seq}
            className={`h-6 ${i < 3 ? (t.aggressor === "buy" ? "flash-up" : "flash-down") : ""} ${
              highlight?.has(t.seq) ? "bg-raised" : ""
            }`}
          >
            <td
              className={`num px-3 font-medium ${t.aggressor === "buy" ? "text-bid" : "text-ask"}`}
            >
              {price(t.price)}
            </td>
            <td className="num px-3 text-right">{qty(t.qty)}</td>
            <td className="num px-3 text-right text-muted">{time(t.time)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
