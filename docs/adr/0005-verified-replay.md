# ADR 0005 — Verified replay in the browser

- Status: Accepted
- Date: 2026-11-15

## Context

MarketLab's central claim is that the engine is deterministic and the server's
state is a pure function of a seed and a log of inputs (ADR 0003, ADR 0004).
Until now a visitor had to take that on trust, or read the tests. The claim is
checkable: if the inputs are enough, anyone holding them can rebuild the state.

## Decision

**Serve the session's inputs, and let the visitor's browser re-run the engine
and compare results with the server.**

### One definition of a session

`SessionEngine` (in `packages/engine`) turns a `SessionConfig` (seed,
instruments, guest cash) and log entries into an exchange. It owns everything
that gives the inputs their meaning: the bot accounts, how each simulator is
seeded and tuned, how a `ticks` entry expands into steps and times. The API's
engine host runs it to serve the market and to rebuild after a restart; the
browser runs the same class. There is no second implementation to keep in
step.

### The state hash, and a hash on every log entry

`Exchange.stateHash()` (ADR 0006) covers the sequence counter, every book with
its queue order, pending stops, last prices and all balances.

Each log entry now also records `h`: the hash of the state it was applied to.
The host computes it before appending (for a `ticks` entry, before the first
of those ticks ran). This costs one hash per user command and one per 30
seconds of ticks, and it turns "the final states differ" into "the states
differ after entry N". The host checks the same hashes when it replays its own
log at startup and warns on a mismatch.

Entries written before this change have no `h`; a replay then relies on the
final hash alone.

### API

| Endpoint                                        | Returns                                                                                                                     | Limit          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `GET /api/replay`                               | Session id, seed and rules, instrument names, and the head: log sequence `seq`, the state hash after it, commands processed | 6 per minute   |
| `GET /api/replay/entries?session=&after=&upto=` | Up to 1,000 log entries after `after`                                                                                       | 120 per minute |

`/api/replay` first writes any unlogged ticks, inside the single-writer queue,
so the hash it returns is exactly "the log up to `seq`, applied". That write is
why it has the tighter limit. A page request for another session answers `409`.

The log is public by design. An entry names a guest only by the opaque random
account id the engine uses (`g_` plus 16 hex digits). Tokens, addresses and
anything else about a visitor are never in the log. Holding an account id
grants nothing: every account request needs a token signed by the server.

### In the browser

- The page downloads the head and the pages of entries, then hands them to a
  **Web Worker**, so the interface stays responsive.
- The worker owns a `Replayer` (also in `packages/engine`, so it is tested
  without a browser). A _step_ is one tick or one guest entry. It replays in
  bursts of 250 steps, reporting progress and the market as it goes.
- The first time it passes an entry boundary it compares its hash with that
  entry's `h`; at the end it compares with the head. The first mismatch is the
  verdict: "Diverged at log entry N", with both hashes. Otherwise: "Your
  browser replayed N engine commands and matched the server exactly".
- It saves a **checkpoint** every 250 steps (the serialised session, a few
  kilobytes, plus references to the candles and trades at that point). Seeking
  backward restores the nearest checkpoint and steps forward, so a seek costs
  at most 250 steps, a few tens of milliseconds.
- The timeline scrubs, plays and pauses at 1×, 10× or 60×. The chart, order
  book and tape are the terminal's own components, fed from the worker.

## Measured

A session with one hour of ticks (6,000 ticks, about 1.17 million engine
commands) replays and verifies in 1.2 to 1.5 seconds in headless Chromium on a
2.1 GHz cloud VM core. The worker script is 25 kB before compression.

## Verification

- `packages/engine/src/replay.test.ts`: a recorded session replays to the same
  hash; the verdict is the same however the replay is driven; scrubbing
  backward and forward gives exactly the frame a straight replay gives; a
  changed quantity, a dropped tick, a different account and a different seed
  are each pinned to the right entry; logs without per-entry hashes still
  verify, and still detect tampering, at the end.
- `apps/api/src/replay.test.ts`: over HTTP, on the in-memory log and on
  PostgreSQL (PGlite), an independent `Replayer` fed the served log reaches the
  server's state hash and command count, including after the server restarted
  from a snapshot. A tampered entry is located. Entries expose only engine
  inputs. Paging is validated and the endpoint is rate-limited.
- `apps/web/e2e/replay.spec.ts`: in a real browser, the page verifies (also
  after a guest places an order), scrubs to the start and the middle, plays and
  pauses, and names the entry when the test hands it a log with one tick
  removed.

## What this does and does not show

It shows that the server's reported state is what the published inputs
produce under the published engine code: the log and the engine are
consistent, and the engine is deterministic across Node and a browser.

It does not show that the log is complete or honest. A server could publish a
log that omits an order, and the replay of that log would verify. The hash is
a 64-bit non-cryptographic checksum: it catches divergence, not forgery. The
check is also only as independent as the code: the browser runs the same
engine source, so a bug in a matching rule is reproduced on both sides, not
caught. The property tests exist for that.

## Consequences and limits

- Replay time grows with the time the server has been awake in the session:
  about 1.3 seconds per hour of ticks. A server awake for a full day would take
  the browser around half a minute, with progress shown throughout. Starting a
  replay from a server snapshot would cap this, but the visitor would then be
  trusting the snapshot, which defeats the point.
- Every engine or simulator change that alters behaviour makes the browser and
  an older running server disagree until the server is redeployed, since the
  web app and the API ship together.
- Each `/api/replay` request can add one `ticks` entry to the log, bounded by
  its rate limit.

## Alternatives considered

- **Compare only the final hash.** Simpler, but a mismatch would say nothing
  about where.
- **Run the replay on the main thread.** A million commands block input for
  over a second.
- **Ship the engine as WebAssembly, or a second implementation.** More
  independent, far more to maintain, and no longer "the same code".
- **Send the browser the server's events to display.** That would be a
  recording, not a replay: nothing would be recomputed, so nothing would be
  verified.
