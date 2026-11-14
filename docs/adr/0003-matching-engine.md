# ADR 0003 — Matching engine design

- Status: Accepted
- Date: 2026-11-14

## Context

The legacy backend filled every order at the simulated price and checked limit
orders on a 4-second timer. There was no order book and no counterparty. The
engine is the core of the product and the main thing a reviewer will read.

## Decision

### Shape: commands in, events out

`Exchange.submit(command)` processes one command to completion and returns the
events it caused (`order.accepted`, `trade`, `order.rested`, `order.filled`,
`order.cancelled`, `stop.triggered`, `order.rejected`). The engine does no I/O.
The API layer persists events and streams them; the UI's inspector renders them.

### Single-threaded, in-memory, deterministic

- One command at a time, no locks, no partial states between commands. This is
  the model real exchanges and the LMAX architecture use for the matching core.
- Order ids and sequence numbers come from one counter. No clock or randomness
  is read inside the engine, so the same commands always produce the same
  events. That makes bugs reproducible and lets the API rebuild state by
  replaying its event log after a restart.

### Matching rules

- **Price-time priority:** best price first; at one price, earliest arrival first.
- **Trade price:** the resting (maker) order's price.
- **Limit orders** trade up to their limit, then rest. **Market orders** walk
  the book and cancel any remainder (`no_liquidity`); they never rest.
- **Stop orders** wait until the last trade price reaches the stop, then execute
  as market orders. Triggering is checked after each command, in arrival order,
  one stop at a time, so cascades are handled and deterministic. A stop placed
  when the price is already through it triggers immediately.
- **Self-trade prevention:** an incoming order that would match its own
  account's resting order cancels that resting order (`self_trade`) and continues.

### Balances and reservations

Each balance is split into `available` and `reserved`:

- a limit buy reserves `qty × limit` cash, and gets the difference back when it
  fills at a better price;
- every sell, including a pending stop, reserves its shares;
- market and stop buys reserve nothing (their price is unknown) and are checked
  fill by fill, cancelling the rest with `insufficient_funds` when cash runs out.

### Data structures

- Per side, price levels in an array sorted worst → best: the best level is the
  last element (O(1) read, O(1) `pop` when it empties). A new level costs a
  binary search plus a splice, O(levels).
- Per level, a FIFO queue with a head index.
- An id → (order, level) index for O(1) cancel lookup. Cancels zero the order's
  remaining quantity at once (level totals stay exact) and the queue skips it
  lazily, compacting when skipped entries dominate.

### Invariants, checked by `Exchange.audit()`

1. Cash and shares are conserved across all accounts; nothing goes negative.
2. Each account's reserved balances equal what its open orders reserve.
3. The book is never crossed; levels are sorted; level totals match their orders;
   time priority holds within each level.
4. No stop is left untriggered once the price has reached it.

Property-based tests (fast-check) run hundreds of random command sequences and
call `audit()` after every command; they also check that limit orders never
trade through their limit and that each order closes exactly once. Mutation
checks (deliberately broken matching, refund, priority and stop logic) all fail
the suite.

### Simulation

`MarketSimulator` drives bots through the same `submit` entry point: a market
maker quoting five levels a side around a random-walk fair value, and noise
traders sending market orders. All randomness comes from one seeded PRNG
(mulberry32), so a seed reproduces a market exactly.

## Measured

`npm run bench -w @marketlab/engine` (Node 22, one core of a cloud VM, bot order
flow): about 700,000–780,000 commands per second; per-command latency p50 0.6 µs,
p99 about 3 µs. In process only; the API's network and database costs will
dominate end-to-end latency.

## Alternatives considered

- **Balanced tree (red-black) for price levels.** O(log n) inserts, but books
  here hold tens of levels; a contiguous array is simpler and faster at that
  size. The level structure sits behind `BookSide`, so it can be swapped.
- **Reject self-trades instead of cancelling the resting order.** Both exist on
  real venues. Cancelling the stale resting order keeps the incoming intent alive.
- **Timestamps for time priority.** Clocks can tie or move backwards; a
  sequence number cannot.
- **Matching inside the database (row locks).** Correct but slow, and it couples
  matching to storage; the database here is the durable log, not the engine.

## Not handled (honest limits)

One symbol per book with no cross-symbol logic; no order amendment (cancel and
replace instead); no iceberg, IOC/FOK or good-till-date orders; no short selling;
no fees.
