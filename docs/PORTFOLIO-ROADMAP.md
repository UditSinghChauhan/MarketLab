# MarketLab — Product Vision and Roadmap

## The product in one line

**MarketLab is a real-time exchange simulator you can watch working.** You open
the link, you are trading as a guest within seconds against a live order book
full of bots, and one toggle shows the engine matching your order step by step.

## What makes it worth a recruiter's time

1. **One hard problem, solved properly:** a price-time priority matching engine
   with partial fills, stop orders, self-trade prevention and balance
   reservations, proven by property-based tests.
2. **Visible engineering:** the engine inspector shows each order's lifecycle
   live, so a visitor sees the system working without reading code.
3. **Shipped:** a live link, a demo GIF, and a README that reads in 30 seconds.

## Plan: three weeks to a finished product

Scope is cut to what can ship and be explained in an interview. Each week is
one or two PRs; the owner reviews and merges.

| Week | Delivers                                                                                                                   | Status  |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0    | TypeScript workspace, integer money, CI, clone content removed                                                             | Done    |
| 1    | Matching engine, seeded bot market, property tests, interview notes                                                        | This PR |
| 2    | TypeScript API (Fastify), PostgreSQL ledger, SSE streaming, guest mode, first live deploy; legacy backend removed          | Next    |
| 3    | Trading terminal (book, tape, chart, keyboard ticket, inspector), landing page, README, demo GIF; legacy frontends removed |         |

### Week 2 detail

- `apps/api`: Fastify + zod contracts shared with the web app.
- One engine process owns the in-memory state; every event is appended to
  PostgreSQL (`events` table plus a double-entry `ledger_entries` table). On
  restart the engine replays the event log.
- SSE streams: order book depth, trades, the caller's own order events.
- Guest sessions: one click creates a funded guest account; no signup.
- Deploy the API and the engine early, so a live link exists from week 2.

### Week 3 detail

- `apps/web`: Vite, React, TypeScript, Tailwind using the tokens in
  [DESIGN-DIRECTION.md](./DESIGN-DIRECTION.md).
- Terminal: order book with depth bars, trade tape, price chart, order ticket
  (`B`/`S`, `L`/`M`, `Enter`, `Esc`), open orders, positions.
- Inspector: a side panel listing the engine events for each order.
- Landing page: the live book as the hero, "how matching works", architecture,
  decisions, honest limits.
- README rewritten for a 30-second reader; demo GIF; architecture diagram.

## Hosting (decided now)

The engine is stateful and long-running, which pure serverless functions do
not support. The plan:

| Part           | Host                                      | Why                                               |
| -------------- | ----------------------------------------- | ------------------------------------------------- |
| Web app        | Vercel                                    | Static build, global CDN, free                    |
| API and engine | Render or Fly.io (one always-on instance) | Keeps the in-memory engine alive between requests |
| Database       | Neon (serverless PostgreSQL)              | Free tier, branches per PR                        |

One engine instance is a deliberate choice: a single writer means no
distributed locking. The interview answer for scale is sharding by symbol.

## Deferred until after interviews start

Session replay UI, analytics (Sharpe, drawdown), a benchmarks page, multiple
symbols in the UI. Each is a good "what I would build next" answer.

## Working agreement

- After each week's PR, an interview prep sheet in `docs/interview/`: likely
  questions, strong answers, tradeoffs, and one exercise to rebuild a piece by hand.
- Read every PR before merging; anything unclear gets explained before it ships.
- Commits are in the owner's name with no AI trailers; nothing goes to `main` directly.

## Definition of done

- A live link that opens into a working market in under 3 seconds, no signup.
- Unit, property and end-to-end tests pass in CI on every PR.
- No third-party brand names, logos or photos of real people.
- The README's first screen shows the product working.
- The owner can explain every module in an interview.
