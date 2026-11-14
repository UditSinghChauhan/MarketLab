/**
 * The hero: the real ORBT order book, live, and one button that places a real
 * order and shows what the engine did with it.
 */

import type { CommandResult } from "@marketlab/contracts";
import { useState } from "react";
import { Link } from "react-router";

import { ApiRequestError, api } from "../lib/api";
import { changeTone, duration, pct, price } from "../lib/format";
import { describeEvent } from "../lib/orders";
import { ensureSession } from "../lib/session";
import { useMarketStream } from "../lib/stream";
import { OrderBookLadder } from "../terminal/OrderBookLadder";

const SYMBOL = "ORBT";

export function HeroDemo() {
  const market = useMarketStream(SYMBOL, null);
  const summary = market.markets.find((m) => m.symbol === SYMBOL);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const tryOrder = async () => {
    setPending(true);
    setError(null);
    try {
      const { token } = await ensureSession();
      setResult(
        await api<CommandResult>("/api/orders", {
          method: "POST",
          token,
          body: { symbol: SYMBOL, side: "buy", type: "market", qty: 5 },
          allow: [422],
        }),
      );
    } catch (e) {
      setError(
        e instanceof ApiRequestError ? e.message : "The exchange isn't reachable right now.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="dark-ui overflow-hidden rounded-xl border border-line bg-surface text-text shadow-[0_32px_64px_-32px_rgb(18_26_38/0.45)]">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{SYMBOL}</span>
            <span className="text-xs text-muted">Orbit Aerospace</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="num text-xl font-semibold tracking-[-0.02em]">
              {price(summary?.last)}
            </span>
            {summary && (
              <span className={`num text-xs ${changeTone(summary.changePct)}`}>
                {pct(summary.changePct)}
              </span>
            )}
          </div>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span
            className={`size-1.5 rounded-full ${market.status === "live" ? "bg-bid" : "bg-pending"}`}
          />
          {market.status === "live" ? "Live order book" : "Connecting"}
        </span>
      </div>

      {result ? (
        <Trace
          result={result}
          onReset={() => {
            setResult(null);
          }}
        />
      ) : (
        <div className="h-[372px]">
          <OrderBookLadder book={market.book} compact />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        {result ? (
          <>
            <span className="text-xs text-muted">That order is in your guest account now.</span>
            <Link
              to={`/terminal/${SYMBOL}`}
              className="text-sm font-medium text-accent hover:underline"
            >
              Continue in the terminal
            </Link>
          </>
        ) : (
          <>
            <span className="text-xs text-muted">
              {error ?? "No signup. You get ₹10,00,000 of play money."}
            </span>
            <button
              type="button"
              onClick={() => void tryOrder()}
              disabled={pending || market.status !== "live"}
              className="h-9 rounded-md bg-bid px-4 text-sm font-semibold text-bg disabled:opacity-50"
            >
              {pending ? "Placing order" : "Buy 5 shares at market"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Trace({ result, onReset }: { result: CommandResult; onReset: () => void }) {
  const t = result.timing;
  const id = result.orderId ?? "";
  return (
    <div className="h-[372px] overflow-y-auto px-4 py-4">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">What the exchange did with {id}</h3>
        <button type="button" onClick={onReset} className="text-xs text-muted hover:text-text">
          Back to the book
        </button>
      </div>
      <dl className="mb-5 grid grid-cols-3 gap-px overflow-hidden rounded-md bg-line text-center">
        {[
          ["Waited", duration(t.queueMs * 1000)],
          ["Logged to Postgres", duration(t.persistMs * 1000)],
          ["Matched", duration(t.engineUs)],
        ].map(([label, value]) => (
          <div key={label} className="bg-raised px-2 py-2">
            <dt className="text-2xs text-muted">{label}</dt>
            <dd className="num text-sm font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <ol className="space-y-3 border-l border-line pl-4">
        {result.events
          .filter((e) => e.type !== "trade" || e.buyOrderId === id || e.sellOrderId === id)
          .map((event) => {
            const { title, detail } = describeEvent(event, id);
            return (
              <li key={`${String(event.seq)}-${event.type}`} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute -left-[1.3rem] top-1.5 size-2 rounded-full bg-accent"
                />
                <span className="text-sm font-medium">{title}</span>
                <p className="text-xs text-muted">{detail}</p>
              </li>
            );
          })}
      </ol>
    </div>
  );
}
