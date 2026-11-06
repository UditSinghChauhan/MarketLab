# ADR 0002 — Integer money and price ticks

- Status: Accepted
- Date: 2026-11-06

## Context

The legacy backend stores prices and cash as JavaScript floats. Binary floating
point cannot represent most decimal fractions exactly (`0.1 + 0.2 === 0.30000000000000004`).
In a ledger, small errors accumulate, and an invariant like "matching never
creates or destroys money" cannot be asserted with exact equality.

## Decision

- **Amounts are integer paise** (1 rupee = 100 paise), typed as a branded
  `Paise` number in `@marketlab/engine`. A plain `number` does not type-check
  where `Paise` is expected; values enter through `paise()` or `parseRupees()`,
  which reject fractions, `NaN`, `Infinity` and anything beyond
  `Number.MAX_SAFE_INTEGER`.
- **Arithmetic throws on overflow** instead of silently losing precision.
- **Prices sit on a tick grid** (`roundToTick`, `isOnTick`). Order-book price
  levels can then be exact map keys.
- **Quantities are positive integers** (`Quantity`).
- **Parsing is strict:** `"1,000"` or `"1.234"` is rejected, not rounded.
  Formatting for display (`formatRupees`) uses Indian digit grouping and is never
  parsed back.
- Property-based tests (fast-check) check the algebra: `subtract(add(a, b), b) === a`,
  parse and format round-trips, and rounding always lands on the grid in the
  requested direction.

## Consequences

- `number` covers about ±₹90 trillion in paise, far beyond any simulated account,
  so `bigint` (slower, awkward to serialise to JSON) is not needed.
- PostgreSQL columns will be `bigint` paise (Phase 2), not `numeric` or `float`.
- The API boundary (Phase 3) converts to and from decimal strings, so clients
  never see raw floats.
