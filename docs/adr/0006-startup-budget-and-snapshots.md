# ADR 0006 — Startup budget and engine snapshots

- Status: Accepted
- Date: 2026-11-15

## Context

The server rebuilds its state on every start by replaying the session's
command log (ADR 0004). On Render's free plan the service is stopped after
about 15 minutes without traffic and started again by the next visitor, so
startup time is something visitors feel. ADR 0004 guessed that "a full day of
ticks replays in seconds" and left snapshots for later. This record measures
it.

## Measured

Time from process start to the first healthy `/api/health`, production build
(`npm start`), PostgreSQL 16 on the same machine, one core of a 2.1 GHz Xeon
cloud VM, default settings (600 ms ticks, four instruments).

| Session                           | Log replayed           | Cold start |
| --------------------------------- | ---------------------- | ---------- |
| New session (30-minute warm-up)   | none (3,000 ticks run) | 1.3–1.7 s  |
| Restart after 30 minutes of ticks | 3,000 ticks            | 1.5 s      |
| Restart after 1 hour              | 6,000 ticks            | 2.3 s      |
| Restart after 6 hours             | 36,000 ticks           | 13 s       |
| Restart after 24 hours            | 144,000 ticks          | 46–55 s    |

Replay is linear: each tick regenerates about 195 bot commands, so a full day
is 28 million engine commands, roughly 2 seconds per simulated hour. Reading
the log from Postgres is negligible; re-running the ticks is the cost. A day-old
session would add close to a minute to a cold start that is already slow, and
would exceed a budget of about 10 seconds after roughly five hours.

## Decision

**Store periodic engine snapshots and replay only the entries after the latest
one.**

- A snapshot is the state right after log entry `seq` was applied: the
  exchange (`Exchange.serialize()`: sequence counter, balances, open orders in
  arrival order, stops, last prices, and each account's remembered client order
  ids, ADR 0004), each simulator's position in its random
  sequence and its fair value, and the read models (candles, tape, order
  history, cost basis). It is stored as JSON text with
  `Exchange.stateHash()` at that point.
- PostgreSQL keeps one row per session in `snapshots (session_id, seq,
state_hash, state)`, replaced on each save and deleted with its session.
- The host takes a snapshot every `SNAPSHOT_MINUTES` (default 10), right after
  a tick flush, inside the single-writer queue, when the engine holds no
  unlogged ticks. It also takes one on graceful shutdown (`SIGTERM`), which is
  how Render stops an idle service.
- On startup the host loads the snapshot, restores it, then replays the log
  entries after `seq`.

### The log stays the source of truth

A snapshot is an optimisation that may be discarded at any time. Before it is
used it must pass every check; otherwise the host logs a warning and replays
the whole log:

1. its format version and the instrument configuration match the running code;
2. its `seq` is not ahead of the log;
3. after restoring, `Exchange.stateHash()` equals the stored hash;
4. `Exchange.audit()` reports no invariant violation.

Failing to store a snapshot is logged and otherwise ignored. Request timings
(the inspector's "waited / logged / matched") are measurements of one process,
so they are not part of a snapshot, exactly as they are not recoverable by
replay.

### The state hash

`Exchange.stateHash()` is a 64-bit hash over the sequence counter, every book
(each level and its queue order), pending stops, last prices and all balances.
It uses 32-bit integer arithmetic only, so every JavaScript runtime computes
the same value. It detects an honest divergence; it is not a cryptographic
commitment.

## Result

Same machine and session sizes as above.

| Start                                             | Replayed  | Cold start |
| ------------------------------------------------- | --------- | ---------- |
| 24-hour session, snapshot from a clean shutdown   | 0 entries | 0.5 s      |
| 24-hour session, killed with `SIGKILL`, restarted | 2 entries | 0.5 s      |
| 24-hour session, snapshot missing or rejected     | whole log | 46–55 s    |

A snapshot of a 24-hour session with a handful of guests is about 260 kB.
After a crash the tail is at most `SNAPSHOT_MINUTES` of ticks plus the user
commands in it: under half a second of replay at the default.

## Verification

- Property tests (fast-check): equal states hash equally; a state restored
  through JSON has the same hash, the same serialised form and produces the
  same events for any further commands; changing any single counter, price,
  balance or order changes the hash; the same orders queued in a different
  order hash differently.
- Host tests, on the in-memory log and on PostgreSQL (PGlite): a 25-minute
  session with guest orders before and after each snapshot is restarted twice,
  once from the snapshot plus tail and once by full replay. Both must have the
  same state hash, depth, last prices, candles, tape, balances, open orders,
  order history and traces, and must then produce identical ticks.
- A snapshot with a wrong hash, unreadable JSON, a sequence ahead of the log,
  or tampered balances is ignored and the full replay result is unchanged.

## Consequences

- Cold start no longer grows with the session's age, in the normal case.
- One more table and about 260 kB written every ten minutes.
- The snapshot format is versioned. Changing engine or read-model state means
  bumping `SNAPSHOT_VERSION`; old snapshots are then ignored and the next start
  replays the whole log once.
- The worst case (no usable snapshot on a day-old session) is still about a
  minute. The web app shows "Starting the exchange" during any slow start.

## Alternatives considered

- **Do nothing.** Acceptable for a session a few hours old, not for one near
  its 24-hour limit, which is exactly when a returning visitor arrives.
- **Shorter sessions (for example 4 hours).** Caps replay at about 8 seconds,
  but resets every guest's account six times a day.
- **Snapshot only on shutdown.** Covers the idle-sleep case but not a crash or
  a redeploy that kills the process.
- **Persist the book and balances as tables.** Rejected in ADR 0004 for the
  same reasons: many writes per command and two sources of truth.
