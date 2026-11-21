# ADR 0009 — Deploys with a single writer

- Status: Accepted
- Date: 2026-11-20

## Context

The engine is a single writer: one process holds a PostgreSQL advisory lock
while it writes the command log (ADR 0004), and releases it only while the
exchange is idle (ADR 0007).

A Render deploy overlaps two processes. This design assumes the following
platform behaviour; it has not been checked on a live Render deploy:

1. Render starts the new instance while the old one keeps serving.
2. It routes traffic to the new instance only once `/api/health` answers 200,
   and gives up on the deploy if that does not happen within 15 minutes.
3. The old instance gets `SIGTERM` 60 seconds after the switch.

The 15-minute and 60-second figures below come from these assumptions.

Until this change, a new instance that found the lock taken exited at
startup. Measured on the built server: exit code 1 after 238 ms, never
listening, with "Another engine process holds the command-log lock". So a
deploy made while anyone was using the site failed. A deploy made while the old
instance was idle went through, but the old instance then hit a fatal error on
its next request, because waking it found the lock taken.

The new instance cannot make the old one stop. Nothing on the platform lets it
signal the old process, and the old process holds the lock for as long as
someone is using the exchange.

## Decision

**A new instance waits, for a bounded time, until the old instance goes idle
and releases the lock. It answers health checks with 503 while it waits. An old
instance that finds it has been superseded refuses all work and waits to be
stopped.**

- **Listen at once.** The port opens before anything else. Until the lock is
  held and the log replayed:
  - `/api/health` answers `503 {"status":"starting","reason":…}`, with the
    reason "waiting for the previous instance", then "replaying the command
    log";
  - every other request gets `503`.

  Health never queries the database. The same server is then handed to the
  app, so the port never closes in between (`apps/api/src/starting.ts`).

- **Wait for the lock.** The new instance polls `pg_try_advisory_lock` every
  2 seconds and logs `lock_waiting` at once and then every 30 seconds. It reads
  nothing from the log (no migration, pruning, session or entries) until it
  holds the lock.
- **Give up in time.** After `LOCK_WAIT_MS` (default 14 minutes, under Render's 15) it logs `lock_waiting` with `gaveUp: true` and exits with code 1. The
  deploy fails and the old instance keeps serving, untouched.
- **The old instance stands down.** If waking from an idle stretch it finds the
  lock taken, or the session's head moved, it is _superseded_:
  - it refuses every request with `503`, and health answers
    `503 {"status":"stopping","reason":"another instance owns the command log"}`;
  - it closes its event streams, stops its clock and writes nothing. A
    stream cannot be open when the old instance releases the lock (a watcher
    keeps it active), but one can connect to it afterwards; that stream's own
    wake-up is what finds the takeover, and it is closed straight away
    (tested: closed 68 ms after it opened);
  - it does not exit. It logs one `persistence_failed` warning with
    `fatal: false` and waits for `SIGTERM`, then exits 0 without writing
    (`finalFlush: "owned-elsewhere"`).

  Exiting would make the platform restart it, and the restarted process would
  contend for the log again.

- A signal while the new instance is still waiting or replaying closes the
  server and exits 0 at once, without serving and without writing. PostgreSQL
  releases the writer lock when it notices the connection has gone: at once
  if the backend is idle, otherwise when its current query ends. Tested with a
  replay query held on a table lock: the lock was still held after the
  process had exited, and freed 20–30 ms after the query could finish. A
  successor waiting for the lock simply polls until then. The same holds for
  a crash, so no cancellation is built for it. A signal that arrives while
  the app is being built takes effect just after readiness (building the app
  does not wait on I/O), through the normal graceful shutdown.

## Why waiting is safe

There is never more than one writer, and the new instance starts from
everything the old one logged.

- **One writer.** The new instance writes only after it holds the lock. The old
  instance writes again only after it retakes the lock (`pg_try_advisory_lock`,
  which fails at once rather than waits) and finds the session's head unchanged
  (ADR 0007). Once the new instance holds the lock, the old one can do neither.
  The gap-free `(session_id, seq)` primary key would refuse an interleaved
  write even if both checks were somehow passed.
- **Nothing a user did is lost.** Before the old instance releases the lock it
  flushes its pending ticks and stores a snapshot. Every order and balance is
  therefore in the log the new instance replays. Tested: the new instance
  replays the whole log and reaches the same state hash as the old instance's
  last snapshot.
- **What is lost** is what ADR 0007 already accepts: bot ticks the old instance
  simulated while idle, after its last write.

## The cost, stated plainly

**This is deferral until the old instance is idle, not a zero-downtime
handover.**

- **A deploy made while someone is on the site finishes only after they
  leave.** The old instance goes idle five minutes after the last stream
  closes and the last order, and the new instance takes over within one poll
  (2 s) plus its replay.
- **If they stay longer than `LOCK_WAIT_MS`**, the deploy fails and the old
  version keeps serving. It has to be deployed again later.
- **The handover window answers 503.** The window runs from the moment the new
  instance takes the lock until Render routes traffic to it, and then while
  the old instance waits 60 seconds for its `SIGTERM`. A request that still
  reaches the old instance gets 503 in milliseconds, not a hang. The web app
  treats 503 as "starting" and retries. Market data the old instance already
  serves from memory is stale only until its next write attempt, which is
  when it notices.
- **The waiting instance keeps one database connection open,** so a deploy
  made during use keeps Neon's compute awake while it waits. The old instance
  is active then anyway.

## Measured

Two built servers against one PostgreSQL 16 database (local Docker), from
`apps/api/src/deploy.test.ts`:

| Case                                                                   | Result                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Before this change: new instance started while the old one is active   | exit 1 after 238 ms, never listened                                                                                                     |
| New instance while the old one is in use (a stream open)               | listening, health `503 starting`; no lock taken                                                                                         |
| The visitor leaves; the old instance suspends after its idle threshold | the new instance ready **1,828 ms** later (lock poll + replay); waited 4,017 ms in all; replayed every entry to the old instance's hash |
| The old instance never goes idle, `LOCK_WAIT_MS=3000`                  | the new instance exits 1 after 3,452 ms (including process start); the old one still serves and logs orders                             |
| A request reaching the old instance after the takeover                 | `503` in **39 ms**; no fatal error; `SIGTERM` exits 0 and writes nothing                                                                |
| `SIGTERM` while still waiting for the lock                             | exit 0 at once                                                                                                                          |

## Alternatives considered

- **Fail at startup (the old behaviour).** Simple and safe, but every deploy
  made during use fails, and an idle old instance crashed on its next request.
- **Block in `pg_advisory_lock`.** The same wait without polling, but the
  database holds the waiting backend with no timeout of our choosing, and
  there is no progress to log. Polling `pg_try_advisory_lock` gives both.
- **Let the new instance take the lock away** (`pg_terminate_backend` on the
  old instance's connection). The old instance would treat its lost
  connection as fatal and restart. Its last writes would race the new
  instance's replay. And anything able to terminate other backends can also
  break the single-writer guarantee.

## Future work: explicit handover

A real handover would let a deploy finish while people are on the site:

1. the new instance asks the old one to hand over, for example with a
   `NOTIFY` or a row both can see;
2. the old instance stops taking orders, flushes, stores a snapshot and
   releases the lock;
3. the new instance replays from that snapshot and starts serving.

The 503 window would shrink to the replay time, about half a second with a
fresh snapshot (ADR 0006). It needs the old instance to listen for the
request while active, a timeout for an old instance that never answers, and
a test of both sides failing midway. Not built here.
