# Interview prep — Week 1: the matching engine

Read this with `packages/engine/src/exchange.ts` and `book.ts` open. Aim to
answer each question in about a minute, out loud, without notes.

## The 30-second pitch

> MarketLab is an exchange simulator. At its core is a matching engine I wrote
> in TypeScript: price-time priority, limit, market and stop orders, partial
> fills and self-trade prevention. It is single-threaded and deterministic —
> commands in, events out — so I can replay any session exactly. Money is
> integer paise, never floats, and property-based tests check after every
> command that money is conserved and the book is never crossed. It handles
> roughly 700,000 orders a second in process.

## Questions you will get

**1. Walk me through what happens when a limit buy arrives.**
Validate (account, symbol, quantity, price on the tick). Reserve `qty × limit`
cash. Emit `order.accepted`. Then match: while there is quantity left and the
best ask is at or below my limit, trade against the oldest order at that price,
at the ask's price. Each trade moves reserved cash to the seller, shares to the
buyer, and refunds the difference if I bought below my limit. Whatever is left
rests in the book (`order.rested`). Finally, check whether the new last price
triggers any stop orders.

**2. What is price-time priority, and where is it in your code?**
Best price first; at the same price, first come first served. Price priority is
the sorted array of levels in `BookSide` — the best level is always the last
element. Time priority is the FIFO queue inside each `Level`. I use a sequence
number, not a timestamp, so two orders can never tie.

**3. Why single-threaded? Won't that be slow?**
Matching is inherently sequential: every order depends on the book state the
previous one left. One thread means no locks and no race conditions, which is
how LMAX and most real exchange cores work. It is far from the bottleneck: about
0.6 µs per order. To scale, you shard by symbol — each symbol's book is
independent — not by adding threads to one book.

**4. Why integers for money?**
`0.1 + 0.2` is not `0.3` in floating point. In a ledger that drift accumulates,
and I could not assert exact conservation. Everything is integer paise in a
branded type, so a raw `number` can't be passed by mistake; arithmetic throws
on overflow instead of losing precision.

**5. How do you know it's correct?**
Three layers. Example tests for each rule (priority, partial fills, stops,
self-trade). Property-based tests with fast-check: hundreds of random order
sequences, and after every single command an `audit()` checks conservation of
cash and shares, that reservations match open orders, that the book isn't
crossed, and that time priority holds. And I mutation-tested the suite: I broke
the refund, the FIFO order, the price comparison and the stop trigger on
purpose, and each one failed the tests.

**6. What is "reserved" balance and why do you need it?**
Without it, I could place two sell orders for the same 100 shares, or two buys
that together exceed my cash. Placing an order moves the amount from
`available` to `reserved`; a fill spends from reserved; a cancel moves it back.
Market buys can't reserve (the price is unknown), so they check cash fill by
fill and cancel the rest when it runs out.

**7. Why is determinism worth having?**
The same commands always produce the same events. Bugs are reproducible from a
command log, the API can rebuild state after a crash by replaying events, and
the bot market is reproducible from a seed. That's why the engine reads no
clock and no `Math.random`.

**8. What's the complexity of your operations?**
Best price: O(1). Matching: O(number of orders it fills). Cancel lookup: O(1)
through the id index; removal is lazy. Adding a new price level: O(log n) to find
the spot plus O(n) to insert into the array. With tens of levels the array is
faster in practice than a tree; it's behind an interface if that changes.

**9. How do stop orders work, and what's tricky about them?**
A stop sell waits until the last trade price falls to its stop, then becomes a
market order. Tricky part: its own fill can move the price and trigger the next
stop — a cascade. I re-check after each triggered stop, one at a time in arrival
order, so cascades are deterministic and each stop fires at most once.

**10. What would you change for production?**
Durable event log before acknowledging an order (Week 2 does this with
Postgres); order amendment; IOC/FOK time-in-force; fees; circuit breakers on
large price moves; and sharding by symbol.

## Tradeoffs to state unprompted

- Cancel the resting order on self-trade, rather than rejecting the incoming one.
- Arrays over trees for price levels at this scale.
- Engine state is in memory; Postgres is the durable log, not the matching store.

## Exercise: make it yours

Without looking, implement `OrderBook.bestOrder(side)` and `Level.front()` from
the description in this file, then run `npm test`. If the tests pass, you can
explain the core of the engine from first principles.
