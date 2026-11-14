import type { TradePrint } from "@marketlab/contracts";

import { price, qty, time } from "../lib/format";

/** The last trades, newest first. Colour shows who crossed the spread: green buyers, red sellers. */
export function TradeTape({
  trades,
  highlight,
}: {
  trades: readonly TradePrint[];
  highlight?: ReadonlySet<number>;
}) {
  if (trades.length === 0) {
    return <p className="p-3 text-sm text-muted">No trades yet in this session.</p>;
  }
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Recent trades</caption>
      <thead className="sticky top-0 bg-surface text-2xs text-muted">
        <tr className="h-7">
          <th scope="col" className="px-3 text-left font-normal">
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
      <tbody>
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
