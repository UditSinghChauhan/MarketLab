/**
 * Order ticket, mounted once per symbol (its parent keys it by symbol, so
 * switching markets starts a clean ticket). Validation uses the same zod schema the server enforces, so a
 * message shown here is exactly the rule the API applies.
 *
 * Keyboard: B / S choose the side, M / L / T the order type, Enter places the
 * order, Esc clears it. Up / Down in a price field moves one tick.
 */

import {
  PlaceOrderRequest,
  type AccountView,
  type CommandResult,
  type MarketSummary,
  type OrderType,
  type Side,
} from "@marketlab/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { ApiRequestError, api } from "../lib/api";
import { price as fmtPrice, qty as fmtQty, rupees, stepPrice } from "../lib/format";
import {
  UNCONFIRMED_ORDER,
  confirmation,
  isCommandResult,
  outcomeUnknown,
  rejectMessage,
  replayedMessage,
} from "../lib/orders";
import { useClientOrderId } from "../lib/useClientOrderId";
import { Kbd } from "../ui/Panel";
import { SkeletonText } from "../ui/Skeleton";

export interface Prefill {
  readonly price: string;
  readonly side: Side;
  readonly nonce: number;
}

type Feedback = { tone: "ok" | "error"; text: string } | null;

const TYPES: { value: OrderType; label: string; key: string }[] = [
  { value: "market", label: "Market", key: "M" },
  { value: "limit", label: "Limit", key: "L" },
  { value: "stop", label: "Stop", key: "T" },
];

/** True while the user is typing, when single-letter shortcuts must not fire. */
export const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);

/** A focused button or link, where Enter already means "activate this". */
const isControl = (target: EventTarget | null) =>
  target instanceof HTMLElement && ["BUTTON", "A"].includes(target.tagName);

export function OrderTicket({
  market,
  account,
  token,
  prefill,
  onResult,
}: {
  market: MarketSummary | undefined;
  account: AccountView | null;
  token: string | null;
  prefill: Prefill | null;
  onResult: (result: CommandResult) => void;
}) {
  const symbol = market?.symbol ?? "";
  const tick = market?.tick ?? "0.05";
  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("market");
  const [qty, setQty] = useState("10");
  const [limit, setLimit] = useState("");
  const [stop, setStop] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const clientOrderIds = useClientOrderId();
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();

  // A click on the book fills in its price as a limit order. Adjusting state
  // while rendering (rather than in an effect) avoids a second render pass.
  const [appliedPrefill, setAppliedPrefill] = useState(prefill);
  if (prefill !== appliedPrefill) {
    setAppliedPrefill(prefill);
    if (prefill) {
      setSide(prefill.side);
      setType("limit");
      setLimit(prefill.price);
      setErrors({});
    }
  }

  const reset = () => {
    setQty("10");
    setLimit("");
    setStop("");
    setErrors({});
    setFeedback(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isField(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "enter" && isControl(event.target)) return;
      const actions: Record<string, () => void> = {
        b: () => {
          setSide("buy");
        },
        s: () => {
          setSide("sell");
        },
        m: () => {
          setType("market");
        },
        l: () => {
          setType("limit");
        },
        t: () => {
          setType("stop");
        },
        enter: () => {
          formRef.current?.requestSubmit();
        },
        escape: reset,
      };
      const action = actions[key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const reference =
    type === "limit"
      ? limit
      : type === "stop"
        ? stop
        : side === "buy"
          ? (market?.ask ?? null)
          : (market?.bid ?? null);
  const shares = Number(qty);
  const estimate =
    reference && Number.isInteger(shares) && shares > 0
      ? (Number(reference) * shares).toFixed(2)
      : null;
  const position = account?.positions.find((p) => p.symbol === symbol);
  const sellable = position ? position.qty - position.reserved : 0;

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (pending || !token || !market) return;
    const parsed = PlaceOrderRequest.safeParse({
      symbol,
      side,
      type,
      qty: shares,
      ...(type === "limit" ? { price: limit.trim() } : {}),
      ...(type === "stop" ? { stopPrice: stop.trim() } : {}),
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await api<CommandResult>("/api/orders", {
        method: "POST",
        body: { ...parsed.data, clientOrderId: clientOrderIds.next(parsed.data) },
        token,
        allow: [422],
        validate: isCommandResult,
      });
      setFeedback(
        result.replayed
          ? { tone: result.ok ? "ok" : "error", text: replayedMessage(result) }
          : result.ok
            ? { tone: "ok", text: confirmation(result.events) ?? "Order placed" }
            : { tone: "error", text: rejectMessage(result.rejectReason) },
      );
      onResult(result);
      // Only now is the outcome known and shown: anything that throws before
      // this line is reported as unknown below, and the id must still be kept.
      clientOrderIds.settled();
    } catch (error) {
      // Unknown outcome: keep the id, so resending the same order is safe.
      const unknown = outcomeUnknown(error);
      if (!unknown) clientOrderIds.settled();
      setFeedback({
        tone: "error",
        text: error instanceof ApiRequestError && !unknown ? error.message : UNCONFIRMED_ORDER,
      });
    } finally {
      setPending(false);
    }
  };

  const priceField = (
    label: string,
    value: string,
    set: (v: string) => void,
    name: "price" | "stopPrice",
  ) => (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-muted">
        {label}
        <span className="num">Tick {fmtPrice(tick)}</span>
      </span>
      <div className="flex h-9 items-center rounded-md border border-line bg-bg focus-within:border-accent">
        <span className="pl-3 text-sm text-muted">₹</span>
        <input
          name={name}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          placeholder={(side === "buy" ? market?.ask : market?.bid) ?? ""}
          onChange={(e) => {
            set(e.target.value.replace(/[^\d.]/g, ""));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = value || (market?.last ?? "0");
              set(stepPrice(base, tick, e.key === "ArrowUp" ? 1 : -1));
            }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          aria-invalid={errors[name] ? true : undefined}
          aria-describedby={errors[name] ? `${id}-${name}` : undefined}
          className="num h-full w-full bg-transparent px-2 text-sm outline-none"
        />
      </div>
      {errors[name] && (
        <span id={`${id}-${name}`} className="mt-1 block text-xs text-ask">
          {errors[name]}
        </span>
      )}
    </label>
  );

  return (
    <form
      ref={formRef}
      onSubmit={(e) => void submit(e)}
      className="flex min-h-full flex-col gap-3 p-3"
      noValidate
    >
      <div
        role="radiogroup"
        aria-label="Side"
        className="grid grid-cols-2 gap-1 rounded-md bg-bg p-1"
      >
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            onClick={() => {
              setSide(s);
            }}
            className={`flex h-8 items-center justify-center gap-2 rounded text-sm font-medium transition-colors ${
              side === s
                ? s === "buy"
                  ? "bg-bid text-bg"
                  : "bg-ask text-bg"
                : "text-muted hover:text-text"
            }`}
          >
            {s === "buy" ? "Buy" : "Sell"}
            <span className={`text-2xs touch:hidden ${side === s ? "opacity-70" : "opacity-60"}`}>
              {s === "buy" ? "B" : "S"}
            </span>
          </button>
        ))}
      </div>

      <div
        role="radiogroup"
        aria-label="Order type"
        className="flex gap-4 border-b border-line text-sm"
      >
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={type === t.value}
            onClick={() => {
              setType(t.value);
            }}
            className={`-mb-px flex h-8 items-center gap-1.5 border-b-2 ${
              type === t.value
                ? "border-accent text-text"
                : "border-transparent text-muted hover:text-text"
            }`}
          >
            {t.label}
            <span className="text-2xs opacity-60 touch:hidden">{t.key}</span>
          </button>
        ))}
      </div>

      <label className="block">
        <span className="mb-1 flex justify-between text-xs text-muted">
          Shares
          <span className="num">
            {side === "sell" ? (
              `You can sell ${fmtQty(sellable)}`
            ) : account ? (
              `Cash ${rupees(account.cash.available)}`
            ) : (
              <>
                Cash <SkeletonText sample="₹10,00,000.00" />
              </>
            )}
          </span>
        </span>
        <input
          name="qty"
          inputMode="numeric"
          autoComplete="off"
          value={qty}
          onChange={(e) => {
            setQty(e.target.value.replace(/\D/g, ""));
          }}
          aria-invalid={errors.qty ? true : undefined}
          aria-describedby={errors.qty ? `${id}-qty` : undefined}
          className="num h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
        />
        {errors.qty && (
          <span id={`${id}-qty`} className="mt-1 block text-xs text-ask">
            {errors.qty}
          </span>
        )}
      </label>

      {type === "limit" && priceField("Limit price", limit, setLimit, "price")}
      {type === "stop" && priceField("Stop price", stop, setStop, "stopPrice")}

      <div className="grid grid-cols-2 gap-2 text-xs">
        {(
          [
            ["Best bid", market?.bid ?? null, "sell"],
            ["Best ask", market?.ask ?? null, "buy"],
          ] as const
        ).map(([label, value, forSide]) => (
          <button
            key={label}
            type="button"
            disabled={value === null}
            onClick={() => {
              if (value === null) return;
              setSide(forSide);
              setType("limit");
              setLimit(value);
              setErrors({});
            }}
            className="rounded-md border border-line px-3 py-2 text-left hover:border-muted disabled:opacity-50"
          >
            <span className="block text-muted">{label}</span>
            <span
              className={`num text-sm font-medium ${forSide === "sell" ? "text-bid" : "text-ask"}`}
            >
              {fmtPrice(value)}
            </span>
            <span className="sr-only">. Use this price to {forSide}.</span>
          </button>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-muted">
        {type === "market" &&
          `Fills now against the best ${side === "buy" ? "asks" : "bids"}; anything the book can't fill is cancelled.`}
        {type === "limit" &&
          `Fills at your price or better; the rest waits in the book behind earlier orders at that price.`}
        {type === "stop" &&
          `Waits until a trade reaches the stop price, then ${side === "buy" ? "buys" : "sells"} at market.`}
      </p>

      <div className="mt-auto space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted">Estimated {side === "buy" ? "cost" : "proceeds"}</span>
          {market ? (
            <span className="num font-medium">{rupees(estimate)}</span>
          ) : (
            <SkeletonText sample="₹12,500.00" className="font-medium" />
          )}
        </div>
        <button
          type="submit"
          disabled={pending || !token || !market}
          className={`flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold text-bg transition-opacity disabled:opacity-50 ${
            side === "buy" ? "bg-bid" : "bg-ask"
          }`}
        >
          {pending
            ? "Placing order"
            : `${side === "buy" ? "Buy" : "Sell"} ${fmtQty(shares || 0)} ${symbol}`}
          {!pending && <Kbd>Enter</Kbd>}
        </button>
        <p
          role="status"
          aria-live="polite"
          className={`min-h-5 text-xs ${feedback?.tone === "error" ? "text-ask" : "text-bid"}`}
        >
          {feedback?.text}
        </p>
      </div>
    </form>
  );
}
