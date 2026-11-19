import type { MarketSummary } from "@marketlab/contracts";
import { NavLink } from "react-router";

import { changeTone, pct, price } from "../lib/format";
import { SkeletonText } from "../ui/Skeleton";
import { SAMPLE_PRICE, SYMBOLS } from "./markets";

/**
 * Every market one tap away on phones and tablets, where the header has no
 * room for the market tabs: symbol, last price and change in four equal cells.
 */
export function MarketStrip({ markets }: { markets: readonly MarketSummary[] }) {
  return (
    <nav
      aria-label="Markets"
      className="grid shrink-0 grid-cols-4 gap-px border-b border-line bg-line lg:hidden"
    >
      {SYMBOLS.map((s) => {
        const m = markets.find((x) => x.symbol === s);
        return (
          <NavLink
            key={s}
            to={`/terminal/${s}`}
            className={({ isActive }) =>
              `flex min-w-0 flex-col gap-0.5 px-3 py-2 text-xs leading-tight ${
                isActive
                  ? "bg-raised text-text shadow-[inset_0_-2px_0_var(--accent)]"
                  : "bg-surface text-muted hover:bg-raised hover:text-text"
              }`
            }
          >
            <span className="font-medium">{s}</span>
            {m ? (
              <>
                <span className="num truncate">{price(m.last)}</span>
                <span className={`num text-2xs ${changeTone(m.changePct)}`}>
                  {pct(m.changePct)}
                </span>
              </>
            ) : (
              <>
                <SkeletonText sample={SAMPLE_PRICE[s] ?? "000.00"} />
                <SkeletonText sample="+0.00%" className="text-2xs" />
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
