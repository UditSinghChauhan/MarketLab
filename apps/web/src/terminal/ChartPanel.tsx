import type { Candle, MarketSummary } from "@marketlab/contracts";
import { useState } from "react";

import { changeTone, pct, price, qty, signedRupees } from "../lib/format";
import type { ExchangeStatus } from "../lib/health";
import { Panel } from "../ui/Panel";
import { SkeletonText } from "../ui/Skeleton";
import { StartingNotice } from "../ui/StartingNotice";
import { SAMPLE_PRICE } from "./markets";
import { PriceChart } from "./PriceChart";

/** The market's name, last price and change over the candle chart. */
export function ChartPanel({
  symbol,
  summary,
  candles,
  candlesLoaded,
  exchange,
}: {
  symbol: string;
  summary: MarketSummary | undefined;
  candles: readonly Candle[];
  candlesLoaded: boolean;
  exchange: ExchangeStatus;
}) {
  const [hovered, setHovered] = useState<Candle | null>(null);
  const shown = hovered ?? null;

  return (
    <Panel
      title={
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-text">{symbol}</span>
          <span>{summary?.name}</span>
        </span>
      }
      aside={
        <span className="num flex gap-3 text-xs text-muted">
          {shown ? (
            <>
              <span>O {price(shown.open)}</span>
              <span>H {price(shown.high)}</span>
              <span>L {price(shown.low)}</span>
              <span>C {price(shown.close)}</span>
              <span>Vol {qty(shown.volume)}</span>
            </>
          ) : summary ? (
            <>
              <span className="hidden sm:inline">Open {price(summary.open)}</span>
              <span className="hidden sm:inline">High {price(summary.high)}</span>
              <span className="hidden sm:inline">Low {price(summary.low)}</span>
              <span>Vol {qty(summary.volume)}</span>
            </>
          ) : null}
        </span>
      }
      className="order-1 h-[420px] md:col-span-2 xl:order-none xl:col-span-1 xl:h-auto"
      bodyClassName="flex flex-col"
    >
      <div className="flex items-baseline gap-3 px-3 pt-2">
        {summary ? (
          <>
            <span className="num text-2xl font-semibold tracking-[-0.02em]">
              {price(summary.last)}
            </span>
            <span className={`num text-sm ${changeTone(summary.changePct)}`}>
              {signedRupees(summary.change)} ({pct(summary.changePct)})
            </span>
          </>
        ) : (
          <SkeletonText
            sample={SAMPLE_PRICE[symbol] ?? "000.00"}
            className="text-2xl font-semibold tracking-[-0.02em]"
          />
        )}
        <span className="ml-auto text-2xs text-muted">15-second candles</span>
      </div>
      <div className="relative min-h-0 flex-1 px-1 pb-1">
        <PriceChart
          candles={candles}
          last={summary?.last ?? null}
          onHover={setHovered}
          loading={!candlesLoaded}
        />
        {exchange.state === "starting" && (
          <div className="absolute inset-0 grid place-items-center p-4">
            <StartingNotice
              since={exchange.waitingSince}
              className="rounded-lg border border-line bg-surface px-6 py-5"
            />
          </div>
        )}
      </div>
    </Panel>
  );
}
