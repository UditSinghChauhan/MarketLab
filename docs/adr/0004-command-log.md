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

Bot orders are never stored; replaying the same ticks with the same seed
regenerates them. A busy session is thousands of rows, not millions.

### Write-ahead, single writer

- Every mutation runs through one promise queue in `EngineHost`, so the log
  order is the application order.
- A user command is appended **before** the engine applies it. If the append
  fails the command is not applied, the caller gets `503`, the host stops
  accepting work and the process exits; the platform restarts it and replay
  restores a consistent state.
- `(session_id, seq)` is the primary key and the host assigns gap-free
  sequence numbers, so a duplicate or out-of-order write is refused by the
  database.
- On startup the process takes a session-level PostgreSQL advisory lock. A
  second instance (a bad deploy, two replicas) fails at startup instead of
  interleaving writes.

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

A session is one simulated trading day with its own seed. After
`SESSION_HOURS` (default 24) a new session starts with a fresh market; guest
tokens carry the session id and expire with it. Sessions older than seven days
are deleted at startup.

## Verification

- Replay tests run a session of ticks and guest commands, start a second host
  from the same log (in memory and on PostgreSQL via PGlite) and require an
  identical fingerprint: sequence, depth, last prices, candles, tape, balances,
  open orders and order history. A further test checks that both copies then
  produce identical ticks.
- A failing append leaves balances untouched and stops the host.
- The advisory-lock test runs against a real PostgreSQL server in CI.

## Consequences and limits

- Startup time grows with the session's length (about 60 ms for a short
  session; a full day of ticks replays in seconds). Periodic snapshots would
  cap this; they are not needed at demo scale.
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
