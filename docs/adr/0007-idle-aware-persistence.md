# ADR 0007 — Idle-aware persistence

- Status: Accepted
- Date: 2026-11-19

## Context

The engine host flushed its counted market ticks to the command log every
30 seconds (ADR 0004) and stored a snapshot every 10 minutes (ADR 0006),
whether or not anyone was using the exchange. The database therefore never
went quiet.

The deployment uses Neon's free plan, whose compute scales to zero after five
minutes without queries. Its allowance is 100 compute-unit hours a month, and
a compute that never idles uses about 0.25 CU × 24 h × 31 days ≈ **186 CU-hours**:
the exchange would run out of database partway through each month, whatever
its traffic.

One more fact shaped the design. When a Neon compute suspends, it closes the
connections still open to it. The engine keeps one connection open for its
whole life, holding the session-level advisory lock that makes it the single
writer (ADR 0004), and treats losing it as fatal. Pausing the writes alone
would therefore not be enough: five minutes later Neon would cut the
connection and the process would crash, restart, wake the database again, and
repeat until the web service itself went to sleep.

## Decision

**Periodic tick flushes and snapshots happen only while the exchange is
active, and while it is idle the log releases its lock and closes its
connection.**

- _Active_ means at least one stream client is connected, or a user did
  something in the last five minutes (`IDLE_AFTER_MS`): placed or cancelled an
  order, opened a guest account, or started or read a replay. `/api/health`
  does not count, so the platform's health checks cannot keep the database
  awake, and it never touches the database anyway.
- Every market tick runs in the single-writer queue (`EngineHost.clockTick`).
  While active it does what it did before: flush ticks every 30 seconds,
  snapshot every 10 minutes.
- On becoming idle, once: flush the pending ticks, store a snapshot, and
  **suspend** the log: `pg_advisory_unlock`, then close the connection. The
  market keeps ticking in memory and nothing is written.
- **Waking** (a stream client connects, a command arrives, a replay starts):
  the next write **resumes** the log. It reconnects, takes the lock with
  `pg_try_advisory_lock` (it fails at once rather than waiting behind another
  writer), and checks that the session's last entry is still the host's own
  `seq`. The idle ticks are then flushed as one `ticks` entry, and a snapshot
  is stored straight away, so a restart soon after does not replay them.
- Unchanged: every user command is preceded by a flush of the pending ticks
  and is logged before it is applied; on graceful shutdown (`SIGTERM`) the
  host flushes and snapshots, resuming the log first if it must. If another
  instance has taken the lock or written to the session meanwhile, it writes
  nothing and exits normally: the idle ticks are not persisted, and the log
  stays exactly as the other instance has it.
- Any failure to resume, flush or suspend stops the host through `onFatal`, as
  a failed append always has; the process restarts and replays the log.

### Replay stays exact

An idle stretch is logged as one `ticks` entry with a large `count`, recorded,
like every entry, with the state hash it was applied to. Replay regenerates
the same ticks from the seed, so the state is still a pure function of the
log: tested by replaying sessions with idle stretches in full, from a
snapshot, and after a user command that interrupted one. Tick times inside an
entry are interpolated between `from` and `at`, as before.

### Single writer while disconnected

While suspended, the engine holds no lock, so another process could start and
write. Three things keep that from corrupting the log: the gap-free
`(session_id, seq)` primary key rejects an out-of-order write; `resume`
retakes the lock without waiting and fails if another process has it; and it
refuses to continue if the session's head moved. Each failure ends in a
restart and a replay of whatever the log holds. (Since ADR 0009, finding the
lock taken or the head moved means a newer instance owns the log: the old
instance refuses all work and waits to be stopped instead of restarting.)

## The trade-off, stated plainly

**Bot ticks generated while nobody is watching are not in the log until
activity returns or the process shuts down gracefully. If the process crashes
in that window, those ticks are lost**: on restart the market resumes from the
last logged state, as if the idle minutes had not happened. That is
acceptable because nothing a user did is in that window. A user's command
flushes the pending ticks and is logged before it is applied, and it keeps the
exchange active for five minutes, so every order and balance is always in the
log. What can be lost is simulated price movement that nobody saw.

Two other costs:

- **The first write after an idle stretch pays for waking.** A new
  connection, TLS, the lock and the head check, plus Neon starting its
  compute if it had scaled to zero. The inspector shows it honestly as that
  order's "Written to the command log" time. Measured below.
- **More compute per visit than the visit itself.** A visit keeps the
  database busy for its length, plus five minutes of engine idle time, plus
  Neon's own five minutes before it suspends: roughly ten minutes, or
  0.04 CU-hours at 0.25 CU. The free allowance covers about 2,400 separate
  short visits a month, against none at all before.

## Measured

### Local PostgreSQL

The built server against PostgreSQL 16 (local Docker), production settings
(600 ms ticks, 30-minute warm-up). One guest order, then nothing but
`/api/health` every 30 seconds; the log and `pg_stat_activity` sampled at the
same rate:

| Time since the last order | Log rows                  | Engine connections | Snapshot at |
| ------------------------- | ------------------------- | ------------------ | ----------- |
| 0.5 – 4.5 min             | 164 → 172, one per 30 s   | 1                  | none        |
| 5.0 min                   | 173 (the last flush)      | **0**              | entry 173   |
| 5.5 – 7.0 min             | 173, unchanged            | 0                  | entry 173   |
| an order arrives          | 176 (ticks, order, ticks) | 1                  | entry 176   |

The process never restarted (same process, no fatal error), and the health
checks did not keep it awake.

| Order                                                    | Written to the log |
| -------------------------------------------------------- | ------------------ |
| Before the idle stretch                                  | 4.9 ms             |
| First after it (reconnect, lock, head check, idle ticks) | 24.8 ms            |
| The next one                                             | 5.8 ms             |

After a restart (snapshot at 176, 2 entries replayed in 18 ms), the replay
page re-ran all 179 entries, 759,168 engine commands including the idle
stretch, in the browser and matched the server's state hash.

### Neon

The same server, run on a development machine against a Neon development
branch over TLS with channel binding, 2026-11-19. Three guest orders, then 16
minutes with nothing but `/api/health` every 30 seconds. During those minutes
the database was not queried at all (a query would itself keep the compute
awake); the evidence is the server's own: its open TCP connections to port
5432, the log sequence in `/api/health`, and its process ids and uptime. The
database was read once before the idle stretch and once after the waking
order.

| Time since the last order | Log sequence (`/api/health`) | Engine connections to :5432 |
| ------------------------- | ---------------------------- | --------------------------- |
| 0.5 – 4.5 min             | 12 → 19, one per 30 s        | 1                           |
| 5.0 min                   | 21 (the last flush)          | **0**                       |
| 5.5 – 16.0 min            | 21, unchanged                | 0                           |
| an order arrives          | 28                           | 1                           |

Health answered `ok` at every poll, the process ids never changed and the
uptime only grew: no restart. After waking, the database held exactly the
entries the server reported (28 rows, highest sequence 28, no gaps), the
wake-up snapshot was at entry 24, and the engine had one connection again.

| Order                                                    | Written to the log |
| -------------------------------------------------------- | ------------------ |
| Before the idle stretch (three orders)                   | 343, 583, 598 ms   |
| First after it (reconnect, lock, head check, idle ticks) | **6,353 ms**       |
| The next two                                             | 539, 519 ms        |

The first order after eleven idle minutes paid about 5.8 seconds more than a
warm one. That is consistent with Neon having suspended the compute and
starting it again, which was not checked in the Neon console. The absolute
times include the long network path from the development machine to Neon
(opening a fresh TLS connection there took 2.4 to 3.2 seconds); a service in
Neon's region pays far less for the round trips, not for the compute's start.

After the idle stretch, the replay page re-ran all 33 log entries in the
browser (974,091 engine commands) and matched the server's state hash. On
`SIGTERM` the host flushed the pending ticks (entry 34) and stored a snapshot
of it within a second. The real-PostgreSQL lock tests also pass against the
same Neon branch: a second engine is refused, and a woken engine whose lock
was taken meanwhile fails instead of waiting.

## Alternatives considered

- **Pause the writes but keep the connection.** Simple, but Neon closes the
  connection anyway when it scales to zero, and the engine would crash and
  restart every few minutes while idle.
- **Keep the connection alive with a periodic query.** Keeps the lock, and
  keeps the compute awake: the original problem.
- **Stop the market clock while idle.** No unlogged ticks at all, but the
  market would visibly freeze and jump, and a returning visitor would find the
  same prices they left.
- **A pooled connection without the advisory lock.** A transaction-mode
  pooler cannot hold a session lock, and the single-writer guarantee would
  rest on the primary key alone.
- **A paid plan with scale-to-zero turned off.** Solves it with money; the
  design above costs nothing and keeps the same guarantees for users.
