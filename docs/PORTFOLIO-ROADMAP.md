# MarketLab — Product Vision and Roadmap

## The product in one line

**MarketLab is a real-time exchange simulator you can watch working.** You trade
against a live order book, and you can open the engine and see every order move
through it.

Today MarketLab is a solid paper-trading app: orders fill at a simulated price,
and a live ticker streams quotes. The roadmap turns it into a system with one
hard engineering problem at its centre, solved visibly, inside a quiet and
premium interface.

---

## Signature features

### 1. A matching engine with a real order book
- Price-time priority matching: best price first, then earliest arrival.
- Order types: market, limit, stop; partial fills; cancel.
- Simulated market participants (bots) keep the book full and moving.
- Market orders walk the book, so large orders get real slippage.
- Deterministic: the same seed always produces the same market, so every bug is reproducible.

### 2. Engine inspector ("under the hood")
A panel that shows each order's lifecycle as it happens —
*received → validated → resting → matched → filled → ledger posted* — with a
timestamp per step and the engine's processing time. Visitors see the system
working without reading code.

### 3. Event-sourced double-entry ledger with replay
- Every change is an immutable event; money moves as balanced debit and credit entries.
- Any portfolio can be rebuilt from its events, and a test proves it.
- A replay timeline rewinds the portfolio and the book.

### Supporting
- One-click guest access and a three-step guided first run.
- Analytics: equity curve, max drawdown, Sharpe ratio, win rate.
- A benchmarks page with load-test numbers (orders/sec, p50 and p99 match latency).

### Removed
- The Pricing, Support, About and Products pages and their assets. They came
  from the Zerodha clone and describe a broker, not this product.
- MUI and Create React App (deprecated).

---

## Technical decisions

| Area | Decision | Reason |
|---|---|---|
| Language | TypeScript everywhere | Types shared from API to UI |
| Repo | npm workspaces: `packages/engine`, `packages/shared`, `apps/api`, `apps/web` | The engine is a pure, independently tested library |
| Money | Integer minor units (paise) and integer price ticks; no floats | Floats cannot represent money exactly |
| Database | **PostgreSQL** (replacing MongoDB) | Transactions and constraints fit a ledger; good serverless hosting options |
| Real-time | SSE for streams, HTTP for commands | Simpler than WebSockets for one-way data |
| Frontend | Vite, React, TypeScript, Tailwind with design tokens, TanStack Query | Modern, fast, typed |
| Testing | Vitest, property-based engine tests (fast-check), API contract tests, Playwright end-to-end | Invariants are proven, not sampled |
| Migration | Strangler pattern: the legacy `backend/`, `dashboard/` and `frontend/` keep running until each is replaced | The app stays usable at every merge |
| Records | Architecture decision records in `docs/adr/` | Reasoning is visible to reviewers |

Engine invariants the property tests must hold:
- Money and shares are never created or destroyed by matching.
- The book never crosses (best bid < best ask after every match).
- Fills respect price-time priority.
- Replaying the event log reproduces the exact state.

---

## Phases

Each phase is one branch (`claude/phase-N-<slug>`), one PR, committed in the
owner's name with no AI trailers. The owner reviews and merges; nothing is
pushed to `main` directly.

| # | Phase | Deliverable | Size |
|---|---|---|---|
| 0 | Foundation | Workspaces, TypeScript, lint, Vitest, CI on every PR, engine package seed with integer money, clone pages removed | M |
| 1 | Engine core | Order book, price-time matching, partial fills, cancel, seeded simulation, property tests | L |
| 2 | Ledger | Postgres schema and migrations, event store, double-entry postings, rebuild-from-events test | L |
| 3 | API and streaming | Typed API (zod contracts in `shared`), event bus feeding SSE, guest mode, rate limits; legacy backend retired | M |
| 4 | Design system | Tokens, type, components per `docs/DESIGN-DIRECTION.md` | M |
| 5 | Trading terminal | Order book, depth chart, trade tape, keyboard order ticket, portfolio; legacy dashboard retired | L |
| 6 | Inspector and replay | Order lifecycle panel and session timeline | M |
| 7 | Analytics and benchmarks | Drawdown and Sharpe, load-test harness, published numbers | M |
| 8 | Landing and README | Minimal landing page with live hero, architecture and decisions pages, demo GIF; legacy landing retired | M |
| 9 | Deploy | Hosting decision record, then deploy | S–M |

Phases 1–3 do not depend on visual design and come first.

### Deployment note (decided in Phase 9)
A matching engine is stateful and long-running; serverless functions are
short-lived and stateless. Options to weigh then:
- Frontend on a serverless host, engine on a small always-on host, Postgres on a serverless provider.
- Each symbol's order book as a Cloudflare Durable Object.

---

## Definition of done
- Unit, property, contract and end-to-end tests pass in CI on every PR.
- No third-party brand names, logos or photos of real people remain.
- Every non-obvious decision has an ADR.
- The README's first screen shows a working product.
- A reviewer can read `packages/engine` in ten minutes and understand the system.
