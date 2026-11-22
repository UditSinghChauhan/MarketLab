/**
 * The order ticket's checks, run on every keystroke. They are the rules the
 * exchange applies, in the same order: the shared contract's shape (a whole
 * quantity from 1 to MAX_ORDER_QTY, a rupee amount), then the engine's own
 * (a price above zero and on the tick, cash for a buy, shares for a sell).
 * Passing them means the request passes `PlaceOrderRequest`; the server still
 * has the last word, since the book and the account can move in between.
 *
 * Money is handled as integer paise (BigInt), never as floats.
 */

import { MAX_ORDER_QTY, type OrderType, type Side } from "@marketlab/contracts";

import { qty as fmtQty, rupees } from "./format";

export interface OrderDraft {
  readonly side: Side;
  readonly type: OrderType;
  /** The shares field as typed. */
  readonly qty: string;
  /** The limit or stop price as typed; ignored for a market order. */
  readonly price: string;
}

export interface OrderContext {
  readonly symbol: string;
  readonly tick: string;
  /** What a market order is estimated at: the best ask for a buy, the best bid for a sell. */
  readonly marketPrice: string | null;
  /** Available cash, or null while the account is unknown. */
  readonly cash: string | null;
  /** Shares of this symbol not already promised to open sell orders; null while unknown. */
  readonly sellable: number | null;
}

/** A `hint` says what is still missing (nothing is wrong yet); an `error` says what is wrong. */
export interface FieldIssue {
  readonly tone: "hint" | "error";
  readonly text: string;
}

export interface OrderCheck {
  readonly ok: boolean;
  readonly qty: FieldIssue | null;
  readonly price: FieldIssue | null;
  /** The quantity, when it is a valid one. */
  readonly shares: number | null;
  /** Estimated cost or proceeds in rupees ("12500.50"), when it can be worked out. */
  readonly estimate: string | null;
}

const hint = (text: string): FieldIssue => ({ tone: "hint", text });
const error = (text: string): FieldIssue => ({ tone: "error", text });

/** "1250.05" → 125005n. Only for strings already known to be well formed. */
const toPaise = (value: string): bigint => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
};

const fromPaise = (paise: bigint): string =>
  `${String(paise / 100n)}.${String(paise % 100n).padStart(2, "0")}`;

function checkQty(value: string): { issue: FieldIssue | null; shares: number | null } {
  if (value.trim() === "") return { issue: hint("Enter a number of shares."), shares: null };
  if (!/^\d+$/.test(value)) {
    return { issue: error("Enter a whole number of shares."), shares: null };
  }
  const shares = Number(value);
  if (shares < 1) return { issue: error("Enter at least 1 share."), shares: null };
  if (shares > MAX_ORDER_QTY) {
    return {
      issue: error(`One order can be at most ${fmtQty(MAX_ORDER_QTY)} shares.`),
      shares: null,
    };
  }
  return { issue: null, shares };
}

/**
 * A limit or stop price. Extra decimals are accepted while parsing (as typed or
 * pasted) so the message can still name the nearest valid prices.
 */
function checkPrice(
  value: string,
  label: string,
  tick: string,
): { issue: FieldIssue | null; paise: bigint | null } {
  const typed = value.trim();
  if (typed === "") return { issue: hint(`Enter a ${label}.`), paise: null };
  const example = `Enter a price like ${rupees("1250.05")}.`;
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(typed);
  if (!match) {
    // "1250." is a price still being typed, not a wrong one.
    return { issue: /^\d+\.$/.test(typed) ? hint(example) : error(example), paise: null };
  }
  const fraction = match[2] ?? "";
  const scale = Math.max(2, fraction.length);
  const unit = 10n ** BigInt(scale - 2); // one paisa, at the typed precision
  const units = BigInt(`${match[1] ?? "0"}${fraction.padEnd(scale, "0")}`);
  if (units === 0n) return { issue: error("Enter a price above zero."), paise: null };

  const tickUnits = toPaise(tick) * unit;
  const below = units - (units % tickUnits);
  if (below !== units) {
    const step = `Prices move in steps of ${rupees(tick)}`;
    const options = [below, below + tickUnits]
      .filter((u) => u > 0n)
      .map((u) => rupees(fromPaise(u / unit)));
    return {
      issue: error(
        options.length === 2
          ? `${step}. The nearest are ${options[0] ?? ""} and ${options[1] ?? ""}.`
          : `${step}. The lowest is ${options[0] ?? ""}.`,
      ),
      paise: null,
    };
  }
  if (scale > 2) {
    // On the tick, but with more decimals than the exchange accepts ("1250.050").
    return {
      issue: error(`Use two decimals: ${rupees(fromPaise(units / unit))}.`),
      paise: null,
    };
  }
  return { issue: null, paise: units };
}

export function checkOrder(draft: OrderDraft, context: OrderContext): OrderCheck {
  const quantity = checkQty(draft.qty);
  const priced = draft.type !== "market";
  const price = priced
    ? checkPrice(draft.price, draft.type === "limit" ? "limit price" : "stop price", context.tick)
    : { issue: null, paise: context.marketPrice === null ? null : toPaise(context.marketPrice) };

  const { shares } = quantity;
  const estimatePaise =
    shares !== null && price.paise !== null ? price.paise * BigInt(shares) : null;
  let qtyIssue = quantity.issue;

  if (shares !== null && price.issue === null) {
    if (draft.side === "buy" && context.cash !== null && estimatePaise !== null) {
      const cash = toPaise(context.cash);
      const unitPrice = price.paise ?? 1n;
      if (estimatePaise > cash) {
        const affordable = cash / unitPrice;
        const about = priced ? "" : "about ";
        qtyIssue = error(
          `That costs ${about}${rupees(fromPaise(estimatePaise))}, more than your ${rupees(context.cash)} cash. ` +
            (affordable > 0n
              ? `Up to ${fmtQty(Number(affordable))} shares fit.`
              : "Not enough for one share."),
        );
      }
    }
    if (draft.side === "sell" && context.sellable !== null && shares > context.sellable) {
      qtyIssue = error(
        context.sellable === 0
          ? `You have no ${context.symbol} to sell.`
          : `You can sell up to ${fmtQty(context.sellable)} ${context.symbol}.`,
      );
    }
  }

  return {
    ok: qtyIssue === null && price.issue === null,
    qty: qtyIssue,
    price: price.issue,
    shares,
    estimate: estimatePaise === null ? null : fromPaise(estimatePaise),
  };
}
