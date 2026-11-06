/**
 * Price ticks and quantities.
 *
 * Exchanges only accept prices on a fixed grid (the tick size). Keeping prices
 * on the grid makes order-book price levels exact map keys and removes any
 * question of two "equal" prices differing by a rounding error.
 */

import { MoneyError, paise, type Paise } from "./money.js";

export type RoundingMode = "down" | "up" | "nearest";

function assertTick(tick: Paise): void {
  if (tick <= 0) {
    throw new MoneyError(`Tick size must be positive, got ${String(tick)}`);
  }
}

function assertPrice(price: Paise): void {
  if (price < 0) {
    throw new MoneyError(`Price must be non-negative, got ${String(price)}`);
  }
}

export function isOnTick(price: Paise, tick: Paise): boolean {
  assertTick(tick);
  return price % tick === 0;
}

/** Snaps a price onto the tick grid. "nearest" rounds halves up. */
export function roundToTick(price: Paise, tick: Paise, mode: RoundingMode = "nearest"): Paise {
  assertTick(tick);
  assertPrice(price);
  const remainder = price % tick;
  if (remainder === 0) return price;

  const down = price - remainder;
  switch (mode) {
    case "down":
      return paise(down);
    case "up":
      return paise(down + tick);
    case "nearest":
      return paise(remainder * 2 >= tick ? down + tick : down);
  }
}

declare const quantityBrand: unique symbol;
/** A strictly positive whole number of shares. */
export type Quantity = number & { readonly [quantityBrand]: true };

export function quantity(value: number): Quantity {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MoneyError(`Quantity must be a positive whole number, got ${String(value)}`);
  }
  return value as Quantity;
}
