# ADR 0008 — Scaling beyond one server

- Status: Proposed (design only; nothing here is built)
- Date: 2026-11-19

## Context

One process runs everything: a single-writer queue feeds one in-memory
engine for all four symbols, every command is appended to one PostgreSQL log
before it is applied (ADR 0004), snapshots bound restart time (ADR 0006), and
the same process serves every server-sent-events client. That is the right
shape for a demo. This record says how it would grow, in what order things
break, and what I would not build.

## What breaks first

Measured on this repository: the built server against PostgreSQL 16 in local
Docker at the production tick rate, 100 visitor market orders through the
HTTP API (the timings are the ones the inspector shows), and the engine
benchmark (`npm run bench -w @marketlab/engine`). A managed database across a
network adds to the append time, so these are best cases.

| Resource                 | Measured today                                                   | Limit it implies                                                                                            |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Log append (write-ahead) | p50 6 ms, p90 9 ms per user command                              | One `await` per command in a serial queue: about **150 user commands/s** for the whole exchange             |
| Matching                 | about 700,000 bot commands/s on one core; a visitor order ~30 µs | Not the constraint until the log is                                                                         |
| Bot load                 | about 195 engine commands per 600 ms tick                        | About 330 commands/s of background work, well under 1 % of one core                                         |
| Stream fan-out           | book ~1 kB up to 4×/s per symbol, markets ~0.9 kB/s, per client  | ~5 kB/s per client; each message is serialised once **per client**, so CPU grows with clients × messages    |
| Memory and restart       | ~110 MB resident; a day's snapshot ~260 kB                       | Fine for one session; grows with open orders, guests and candle history, and every symbol restarts together |

So the order is: **PostgreSQL write latency** caps user throughput first,
then **SSE connections per process** (serialisation and socket buffers; the
1 MB slow-client cap bounds memory, not CPU), then memory and restart time.

## Decision (if this had to scale)

1. **Fix the cheap things in place first.** Group commit: append every command
   waiting in the queue in one `INSERT`, then apply them in order; throughput
   becomes about batch size ÷ 6 ms with the same guarantees, because nothing is
   applied before its batch is durable. Serialise each stream message once and
   write the same string to every client.
2. **Partition the engine by symbol.** A symbol's book never touches another
   symbol's book, so each partition is a separate process with its own single
   writer, its own seed and its own command log (`log_entries` keyed by
   `(partition, session, seq)`), its own snapshots and its own advisory lock.
   Determinism and verified replay stay per partition, unchanged.
3. **Cash is the shared state.** A guest's balance is reserved by orders in
   every symbol. Give each partition a cash allocation per guest, moved by
   logged `transfer` commands through a small ledger service; an order can only
   spend what its partition holds. This keeps every partition's state a pure
   function of its own log.
4. **Snapshot compaction and log truncation.** Once a snapshot at `seq` is
   verified (hash and audit, as today), entries at or below it can be moved to
   cold storage and deleted. Keep the last two snapshots so a corrupt one still
   has a fallback, and keep whole logs for sessions anyone may still replay.
5. **A separate stream gateway.** Partitions publish their events to a
   gateway tier (one connection per partition, for example over Redis Pub/Sub
   or NATS); gateways hold the browsers' SSE connections, coalesce books and
   scale horizontally behind a load balancer. The engine then never sees a
   browser, and a slow client can only hurt its gateway.

## What I would deliberately not build

- **Consensus or replicated engines (Raft, active-active).** A partition is a
  single writer with a durable log; failover is "start another process, take
  the lock, restore the snapshot, replay the tail", which ADR 0006 measured at
  half a second.
- **Cross-symbol atomic orders** (pairs, baskets). They would force
  coordination between partitions on the hot path.
- **A distributed cash ledger with two-phase commit** between partitions.
  Allocations move by explicit, logged transfers instead.
- **Sharding inside one symbol.** Price-time priority is a total order per
  book; splitting a book splits the rule.
- **WebSockets for market data.** The flow is still one-way; SSE through a
  gateway scales the same way and keeps commands as plain HTTP.

## Consequences

- Steps 1 and 5 alone probably cover more traffic than a demo will ever see.
- Partitioning changes the replay page: it verifies one partition at a time.
- Each partition is a process to deploy, monitor and lock, which is real
  operational cost; it is only worth paying when one writer is full.
