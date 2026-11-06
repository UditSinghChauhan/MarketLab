/**
 * Money primitives.
 *
 * All amounts are integer paise (1 rupee = 100 paise). Floating-point rupees
 * cannot represent values like 0.1 exactly, and rounding drift in a ledger is a
 * correctness bug, not a cosmetic one. See docs/adr/0002-integer-money.md.
 *
 * `Paise` is a branded number: a plain `number` cannot be passed where `Paise`
 * is expected, so every amount enters the system through `paise()` or
 * `parseRupees()`, which reject non-integers and values beyond
 * Number.MAX_SAFE_INTEGER.
 */

declare const paiseBrand: unique symbol;
export type Paise = number & { readonly [paiseBrand]: true };

export const PAISE_PER_RUPEE = 100;

export class MoneyError extends Error {
  override name = "MoneyError";
}

/** Wraps an integer number of paise. Throws on fractions, NaN, Infinity or unsafe integers. */
export function paise(value: number): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Expected a safe integer amount of paise, got ${String(value)}`);
  }
  return value as Paise;
}

export const ZERO: Paise = paise(0);

export function add(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subtract(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function negate(a: Paise): Paise {
  // `0 - a` rather than `-a`: unary minus turns 0 into -0.
  return paise(0 - a);
}

export function compare(a: Paise, b: Paise): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** price × quantity, rejecting any result that cannot be represented exactly. */
export function notional(price: Paise, qty: number): Paise {
  if (!Number.isSafeInteger(qty) || qty < 0) {
    throw new MoneyError(`Expected a non-negative integer quantity, got ${String(qty)}`);
  }
  return paise(price * qty);
}

const RUPEE_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a plain decimal rupee string ("1234", "1234.5", "-0.05") into paise.
 * Grouping separators and more than two decimals are rejected rather than
 * silently rounded.
 */
export function parseRupees(input: string): Paise {
  const match = RUPEE_PATTERN.exec(input.trim());
  if (!match) {
    throw new MoneyError(`Not a valid rupee amount: "${input}"`);
  }
  const [, sign, whole = "0", fraction = ""] = match;
  const magnitude = Number(whole) * PAISE_PER_RUPEE + Number(fraction.padEnd(2, "0"));
  return paise(sign && magnitude !== 0 ? -magnitude : magnitude);
}

function splitMagnitude(amount: Paise): { negative: boolean; rupees: number; paiseRest: string } {
  const negative = amount < 0;
  const magnitude = Math.abs(amount);
  return {
    negative,
    rupees: Math.trunc(magnitude / PAISE_PER_RUPEE),
    paiseRest: String(magnitude % PAISE_PER_RUPEE).padStart(2, "0"),
  };
}

/** Plain decimal string, the inverse of `parseRupees`: 123450 → "1234.50". */
export function toDecimalString(amount: Paise): string {
  const { negative, rupees, paiseRest } = splitMagnitude(amount);
  return `${negative ? "-" : ""}${String(rupees)}.${paiseRest}`;
}

const indianGrouping = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** Display string with Indian digit grouping: 10000000 → "₹1,00,000.00". */
export function formatRupees(amount: Paise): string {
  const { negative, rupees, paiseRest } = splitMagnitude(amount);
  return `${negative ? "-" : ""}₹${indianGrouping.format(rupees)}.${paiseRest}`;
}
