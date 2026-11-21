# ADR 0004 — Command log, single writer and replay

- Status: Accepted
- Date: 2026-11-14

## Context

The matching engine (ADR 0003) is in memory. The API must survive restarts,
including the frequent cold starts of small hosting plans, without losing
anyone's orders or balances. The simulated market generates around 25 bot
commands per tick across four symbols; storing every resulting event would
mean tens of millions of rows a day for a demo.

## Decision

### Store inputs, not state

The engine is deterministic: its state is a pure function of the seed and the
ordered inputs. PostgreSQL therefore stores the **inputs** in one append-only
table, `log_entries (session_id, seq, entry jsonb)`:

| Entry     | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `open`    | A guest account was opened (its id is generated before logging)     |
| `command` | A user's place or cancel command, exactly as submitted              |
| `ticks`   | The bot market advanced `count` ticks between times `from` and `at` |

Every entry also records `h`, the engine's state hash before the entry was
applied, so a replay can be checked entry by entry (ADR 0005).

Bot orders are never stored; replaying the same ticks with the same seed
regenerates them. A busy session is thousands of rows, not millions.

### Write-ahead, single writer

- Every mutation runs through one promise queue in `EngineHost`, so the log
  order is the application order.
- A user command is appended **before** the engine applies it. If the append
  fails the command is not applied, the caller gets `503`, the host stops
  accepting work and the process exits; the platform restarts it and replay
  restores a consistent state.
- **Unknown outcome.** If the connection drops after PostgreSQL committed the
  append but before its reply arrived, the host cannot tell that the command
  was logged. It treats the write as failed: the caller gets `503` and the
  process restarts, and the replay then applies the command.
- **Client order ids** make the retry after an unknown outcome safe. A place
  order may carry a `clientOrderId` (a UUID); the web app sends one with every
  order and reuses it when it resends an unconfirmed order unchanged. The id is
  part of the logged command, and the exchange remembers, per account, the last
  500 ids and what became of each (the order created, or why it was refused).
  Before logging a command, the host looks its id up: a known id is answered
  with the first outcome (`ok`, `orderId`, `rejectReason`), marked
  `"replayed": true`, and nothing is logged; the same id with different details
  is refused with `409`. The answer also carries the order as it stands now
  (`order`) while the read models still hold it. They keep an account's last
  200 accepted orders, fewer than the 500 remembered ids, so a remembered
  accepted order can come back with `order: null` once it has left that
  history. The retry is still recognised and nothing is placed; only the view
  is gone. A rejected order has no view, so its `order` is always null; it
  uses one of the 500 id slots but never enters the order history. Because the ids are rebuilt by replaying the log, are
  stored in snapshots and are part of the state hash, a restart (from the whole
  log or from a snapshot) and the browser's verified replay all know them.

  What this guarantees, and what it does not:
  - Within one market session, an account's order with a given id is placed at
    most once, however often it is sent, while the id is among the account's
    last 500.
  - It is not exactly-once. An order whose request never reached the log is
    not placed at all until the client sends it again. An id older than the
    account's last 500 is forgotten, so a retry that late would place the order
    again. A session rollover ends the account, so there is nothing to retry
    into. A client that sends no id can still create a duplicate. Cancels carry
    no id; cancelling twice is already harmless (the second is refused).
  - The server can only recognise an id the client sends again. The web app
    keeps an unconfirmed order's id in memory, in the order form that sent it,
    and nowhere else: a page reload, a closed tab, leaving the page, or anything
    that remounts the form (switching markets in the terminal does) forgets it.
    The guest account survives a reload (its token is in `localStorage`), so
    sending the same order after one goes out with a new id and places a second
    order if the first was committed. The web app therefore promises a safe
    resend only from the same open form, and asks the visitor to check their
    orders first. Keeping the id across reloads (browser storage, per account)
    is a separate decision, not taken here.
  - Cost, measured on a development machine: 132 bytes of snapshot per remembered id. At the bound (500
    guests with 500 ids each) that is 31 MB more snapshot, about 1.1 ms per
    command for the state hash instead of 0.5 ms, and 0.2 s once after a
    snapshot is restored. With ten ids per guest none of it is measurable.

- `(session_id, seq)` is the primary key and the host assigns gap-free
  sequence numbers, so a duplicate or out-of-order write is refused by the
  database.
- On startup the process takes a session-level PostgreSQL advisory lock. A
  second instance (a bad deploy, two replicas) fails at startup instead of
  interleaving writes. (Since ADR 0009 it first waits a bounded time for the
  lock, as a deploy needs; it still never writes without it.)

### Ticks are counted, not logged one by one

Ticks are applied immediately and counted. The count is flushed as one `ticks`
entry before the next `open` or `command` (so the log keeps application order),
every 30 seconds, and on shutdown. A crash can lose at most 30 seconds of bot
activity with no user command in it, and because the simulator is seeded, the
restarted process regenerates the same ticks anyway.

### Read models are folds

Prices, candles, the trade tape, cost basis, order status and per-order traces
are computed by folding engine events (`MarketData`). Replay feeds the same
events through the same code, so they are rebuilt with no tables of their own.
Replayed tick times are interpolated between `from` and `at`; they only date
trades and candles.

### Sessions

A session is one simulated trading day with its own seed. Once it is
`SESSION_HOURS` old (default 24), it ends when the engine is next idle (no
stream client and no activity for five minutes), or at a restart, and a new
session starts with a fresh market. Rolling over in the running process
inside the write queue means an always-on server never replays more than one
session's log, and no command straddles two sessions. Guest tokens carry the
session id and expire with it; a command already queued for the old session
is refused, not logged into the new one. Sessions that started more than
seven days ago are deleted at startup and at each rollover; the current
session never is.

## Verification

- Replay tests run a session of ticks and guest commands, start a second host
  from the same log (in memory and on PostgreSQL via PGlite) and require an
  identical fingerprint: sequence, depth, last prices, candles, tape, balances,
  open orders and order history. A further test checks that both copies then
  produce identical ticks.
- A failing append leaves balances untouched and stops the host.
- The advisory-lock test runs against a real PostgreSQL server in CI.
- The built server, run as a process against real PostgreSQL
  (`apps/api/src/persistence.test.ts`): its connection killed between writes
  and during an append, a reply lost after the commit (the unknown outcome
  above: a retry with the order's `clientOrderId` is answered with it, one
  without creates a duplicate), a corrupt stored snapshot, two
  processes starting at once, and waking while the database is unreachable.
  Each failure is fatal, leaves no snapshot ahead of the log, and a restart
  reaches the log head's state hash.

## Consequences and limits

- Startup time grows with the session's length. Measured later: about 2 seconds
  per simulated hour, close to a minute for a full day. Periodic snapshots now
  cap it; see [ADR 0006](0006-startup-budget-and-snapshots.md).
- Neon must be reached through its **direct** connection string; a
  transaction-mode pooler cannot hold a session-level advisory lock.
- One engine process serves all symbols. Scaling out means sharding by symbol,
  one writer per shard.

## Alternatives considered

- **Event store of engine outputs.** Simpler to query, but orders of magnitude
  more rows, and still needs the engine to rebuild state.
- **Persisting balances and the book as tables on every change.** Turns each
  command into many writes and splits the source of truth between memory and the
  database.
- **Periodic snapshots only.** Loses every command since the last snapshot.
