/**
 * The hero: the real ORBT order book, live, and one button that places a real
 * order and shows what the engine did with it.
 */

import type { CommandResult } from "@marketlab/contracts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { ApiRequestError, api } from "../lib/api";
import { changeTone, duration, pct, price } from "../lib/format";
import { useExchange } from "../lib/health";
import { describeEvent, isCommandResult, outcomeUnknown, replayedMessage } from "../lib/orders";
import { ensureSession } from "../lib/session";
import { useClientOrderId } from "../lib/useClientOrderId";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useMarketStream } from "../lib/stream";
import { OrderBookLadder } from "../terminal/OrderBookLadder";
import { SkeletonText } from "../ui/Skeleton";
import { StartingNotice } from "../ui/StartingNotice";

const SYMBOL = "ORBT";
/** Below 640 px the ladder shows five rows a side, not six, so the button stays near the top. */
const WIDE = "(min-width: 640px)";

export function HeroDemo() {
  const exchange = useExchange();
  const starting = exchange.state === "starting";
  const market = useMarketStream(SYMBOL, null, { enabled: exchange.state === "ready" });
  const summary = market.markets.find((m) => m.symbol === SYMBOL);
  const wide = useMediaQuery(WIDE);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The swap between the book and a trace fades in; the first view appears without it.
  const [swapped, setSwapped] = useState(false);
  const buyRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const clientOrderIds = useClientOrderId();

  // Back from a trace, focus returns to the button that opened it.
  useEffect(() => {
    if (returnFocus.current && !result) {
      returnFocus.current = false;
      buyRef.current?.focus();
    }
  }, [result]);

  const tryOrder = async () => {
    setPending(true);
    setError(null);
    let ordering = false;
    try {
      const { token } = await ensureSession();
      const order = { symbol: SYMBOL, side: "buy", type: "market", qty: 5 } as const;
      ordering = true;
      const placed = await api<CommandResult>("/api/orders", {
        method: "POST",
        token,
        // The token is part of the details: a new guest account means a new order.
        body: { ...order, clientOrderId: clientOrderIds.next({ order, token }) },
        allow: [422],
        validate: isCommandResult,
      });
      setSwapped(true);
      setResult(placed);
      clientOrderIds.settled(); // only once a valid result is in hand
    } catch (e) {
      // Only the order request can have an unknown outcome; keep its id for a retry.
      const unknown = ordering && outcomeUnknown(e);
      if (!unknown) clientOrderIds.settled();
      setError(
        unknown
          ? "Couldn't confirm that order; it may have been placed. Pressing the button again on this page won't place it twice. After a reload, check Orders in the terminal first."
          : e instanceof ApiRequestError
            ? e.message
            : "The exchange isn't reachable right now.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="dark-ui overflow-hidden rounded-xl border border-line bg-surface text-text shadow-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{SYMBOL}</span>
            <span className="text-xs text-muted">Orbit Aerospace</span>
          </div>
          <div className="flex items-baseline gap-2">
            {summary ? (
              <>
                <span className="num text-xl font-semibold tracking-[-0.02em]">
                  {price(summary.last)}
                </span>
                <span className={`num text-xs ${changeTone(summary.changePct)}`}>
                  {pct(summary.changePct)}
                </span>
              </>
            ) : (
              <SkeletonText
                sample="1,250.00"
                className="text-xl font-semibold tracking-[-0.02em]"
              />
            )}
          </div>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted" role="status">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${market.status === "live" ? "bg-bid" : "bg-pending"}`}
          />
          {market.status === "live" ? "Live order book" : starting ? "Starting" : "Connecting"}
        </span>
      </div>

      {/* One fixed height for the book and the trace, so the card never changes size:
          the ladder's header, mid row and 5 or 6 rows a side. */}
      <div className="relative h-[320px] overflow-hidden sm:h-[372px]">
        <div key={result ? "trace" : "book"} className={`h-full ${swapped ? "hero-swap" : ""}`}>
          {result ? (
            <Trace
              result={result}
              onReset={() => {
                returnFocus.current = true;
                setResult(null);
              }}
            />
          ) : (
            <>
              <OrderBookLadder book={market.book} compact compactRows={wide ? 6 : 5} />
              {starting && !market.book && (
                <div className="absolute inset-0 grid place-items-center p-4">
                  <StartingNotice
                    since={exchange.waitingSince}
                    className="rounded-lg border border-line bg-surface px-6 py-5"
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

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
            <span className="text-xs text-muted">{error ?? "Play money, no signup."}</span>
            <button
              ref={buyRef}
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
  const id = result.orderId ?? "";
  // The button that placed the order is gone, so focus moves to what replaced it.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Already on screen: it replaces the book in the card that held the button.
    heading.current?.focus({ preventScroll: true });
  }, []);
  // As tall as the book it replaces; a long trace (many fills) scrolls.
  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">
          What the exchange did with {id}
        </h3>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 whitespace-nowrap text-xs text-muted hover:text-text"
        >
          Back to the book
        </button>
      </div>
      {result.replayed ? (
        // A retry the exchange recognised: nothing new happened to trace.
        <p className="text-sm text-muted">{replayedMessage(result)}</p>
      ) : (
        <TraceDetail result={result} id={id} />
      )}
    </div>
  );
}

function TraceDetail({ result, id }: { result: CommandResult; id: string }) {
  const t = result.timing;
  return (
    <>
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
    </>
  );
}
