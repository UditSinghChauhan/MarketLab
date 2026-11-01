# MarketLab — Portfolio Roadmap and Claude Code Playbook

This document is the direction for turning MarketLab into a portfolio piece that
reads as senior full-stack work on first glance. It is written so you can run each
phase in Claude Code by pasting the prompt under it. Deployment to serverless
platforms is deliberately last.

---

## 1. Where the project stands

| Area | Today | Problem a recruiter will notice |
|---|---|---|
| Backend | `backend/index.js`, 1,282 lines | Auth, order engine, snapshots, routes and persistence in one file |
| Persistence | `if (useMemoryStore)` branches in almost every function | Two code paths to keep in sync; untestable without Mongo |
| Order engine | Limit and stop-loss checked by a global `setInterval` every 4 s | Engine logic is mixed with I/O; not unit-testable |
| Live data | SSE per client with its own interval; dashboard refetches on `window` custom events | No event model; each client re-triggers work |
| Auth | PBKDF2 + HMAC token in `localStorage` | Good primitives, but the token-in-localStorage choice is undocumented |
| Unauthenticated reads | Fall back to the demo user | Ambiguous security model |
| Tests | 5 backend integration tests | No unit tests for the engine; no frontend tests; CI runs on `main` pushes only |
| Landing site | Kite, Kite Connect, Varsity, smallcase logos and a photo of a real person | Clone-derived branding; a real person's image in a portfolio |
| Dashboard | Functional MUI and Chart.js screens | Generic admin look; no keyboard flow; no design system |

The positives to keep and show off: the order engine semantics, SSE feed,
PBKDF2 hashing, rate limiting, the integration suite and a clean commit history.

---

## 2. Target state (what "exceptional" means here)

**Backend**
- `src/` layout with bounded modules: `auth`, `market`, `orders`, `portfolio`, `watchlist`, `http`, `events`, `store`.
- The order engine is a **pure function**: `(order, quote, portfolio) → { status, fills, portfolioDelta }`. No I/O, no timers.
- A single `Store` interface with `MemoryStore` and `MongoStore` adapters. Business code never checks which one is active.
- An in-process **event bus** (`price.tick`, `order.filled`, `order.triggered`, `portfolio.snapshot`). SSE subscribes to events instead of running its own timers.
- Snapshots and limit evaluation are scheduled **per tick**, not per global interval.
- Typed request validation (zod or a small schema module), and one error envelope.
- Architecture decisions recorded in `docs/adr/` (for example: why SSE over WebSockets, why a hand-rolled token, why an in-memory store).

**Testing and quality**
- Unit tests for the engine (table-driven: market, limit, stop-loss, partial cases, cancel races).
- Contract tests for the HTTP API.
- Frontend tests with React Testing Library for the order ticket and the watchlist.
- CI on pull requests, with lint, tests and a production build, and a status badge.

**Design**
- One product identity: name, mark, a restrained palette, a type scale, and a spacing and radius scale, written down as `docs/DESIGN.md`.
- Dashboard: a dense, terminal-style layout with a keyboard-first order ticket (`B` buy, `S` sell, `Enter` submit, `Esc` cancel), tabular numerals, and clear P&L colour semantics.
- Landing page: product-led. The hero is a live, interactive product preview, not marketing copy. No third-party marks, no real people's photos.
- Accessibility: contrast checked, focus states visible, `prefers-reduced-motion` respected.

**Proof for a recruiter, in under 30 seconds**
- A GIF or short video of placing a limit order that triggers, live in the UI.
- An architecture diagram in the README.
- A "Decisions" section linking the ADRs.
- A "Tradeoffs and limits" section that names what is simulated and why.

---

## 3. Phases

Each phase is one branch, one PR, and one reviewable diff. Do them in order.

Branch naming: `claude/phase-N-<slug>`. Commit as the repository owner, with no AI
trailers. Never push to or merge into `main`.

### Phase 0 — Lock the baseline (small)

Goal: a green baseline and a PR-level CI before any refactor.

**Prompt**
> Read `README.md` and `backend/index.js`. Make CI run on `pull_request` for all
> branches, not only `main`. Add a `lint` script (ESLint, backend and dashboard),
> and make CI run lint, backend tests and a dashboard production build. Do not
> change application behaviour. Show the diff summary and the CI config, and
> confirm the 5 existing tests still pass.

### Phase 1 — Backend architecture split (large, the core of the story)

Goal: split the monolith with no behaviour change. The 5 integration tests must
pass unchanged.

**Prompt**
> Refactor `backend/index.js` into modules without changing any HTTP behaviour.
> Target layout: `src/app.js` (Express wiring), `src/server.js` (listen and
> timers), `src/config.js`, `src/auth/` (hashing, tokens, middleware, routes),
> `src/market/` (wrap `marketData.js`), `src/orders/` (engine and routes),
> `src/portfolio/`, `src/watchlist/`, `src/store/` (interface plus `memory.js` and
> `mongo.js`). Remove every `if (useMemoryStore)` branch from business code by
> moving it into the store adapters. Keep `tests/run-tests.js` passing with no
> edits to its assertions. Write a short `docs/adr/0001-module-layout.md` explaining
> the boundaries. Do not change public routes, response shapes or status codes.
> Show me the module tree and the before-and-after line counts.

### Phase 2 — Pure order engine and event bus (large)

Goal: the part interviewers will ask about.

**Prompt**
> Extract the order evaluation logic into a pure module `src/orders/engine.js`
> with no I/O and no timers. Its input is an order, a quote and a portfolio
> snapshot, and it returns the status, fills and portfolio delta. Add an in-process
> event bus in `src/events/bus.js` emitting `price.tick`, `order.filled`,
> `order.triggered` and `portfolio.snapshot`. Replace the global 4-second intervals
> with handlers on `price.tick`. The SSE endpoint must subscribe to the bus and
> unsubscribe on `close`; it must not run its own timer. Add unit tests in
> `tests/engine.test.js` covering: market BUY and SELL, limit trigger above and
> below, stop-loss trigger, cancel before trigger, cancel after trigger rejected,
> and insufficient funds or holdings at trigger time. Write
> `docs/adr/0002-pure-engine-and-events.md`. Keep HTTP behaviour identical.

### Phase 3 — Security model made explicit (medium)

Goal: turn the known limitations into deliberate decisions.

**Prompt**
> Make the auth model explicit. Replace the implicit demo-user fallback with an
> explicit read-only guest mode: unauthenticated `GET` requests return the demo
> account, and every mutation requires a valid token. Add token rotation or at least
> a documented expiry policy. Validate all request bodies with a schema module and
> return one error envelope `{ error: { code, message } }`. Add a test for each rule.
> Write `docs/adr/0003-auth-model.md` covering the token format, why it is stored
> in `localStorage`, the XSS tradeoff, and the migration path to httpOnly cookies.

### Phase 4 — Design system and identity (medium)

Goal: remove all third-party branding and define the product's look.

**Prompt**
> Read `docs/DESIGN.md` if it exists; otherwise create it. Define an original
> MarketLab identity: a name treatment and mark drawn in SVG, a palette with
> semantic tokens (`--bg`, `--surface`, `--text`, `--muted`, `--gain`, `--loss`,
> `--accent`) for light and dark, a type scale with tabular numerals for prices, a
> 4-point spacing scale and radii. Put the tokens in one CSS file used by both the
> landing site and the dashboard. Then remove every third-party logo, Kite, Varsity,
> smallcase, Zerodha wording and the photo of a real person from `frontend/`.
> Replace them with original SVG illustrations and copy written for MarketLab.
> List every file you change and confirm no third-party marks remain with a grep.

### Phase 5 — Dashboard redesign and keyboard-first trading (large)

**Prompt**
> Redesign the dashboard using the tokens from Phase 4. Layout: a watchlist rail, a
> central chart and market-depth-style order book summary, and a persistent order
> ticket. Add keyboard shortcuts: `B` and `S` set side, `L` and `M` set order type,
> `Enter` submits, `Esc` clears, `/` focuses the watchlist search. Show a visible
> shortcut legend. Respect `prefers-reduced-motion`. Replace the generic MUI cards
> with the design system components. Keep every existing API call. Add React Testing
> Library tests for the order ticket: validation messages, side and type switching,
> and keyboard submission. Record a 20-second GIF of a limit order triggering and
> save it as `docs/demo.gif`.

### Phase 6 — Landing page as a product showcase (medium)

**Prompt**
> Rebuild the landing page around the live product. Hero: a headline, one sentence
> of value, and an interactive, read-only preview driven by the real
> `/market-feed` endpoint. Sections: how the engine works (order types as a small
> state diagram), an architecture section, a "decisions" section linking the ADRs,
> and a "what is simulated" section. Remove the pricing, awards, press and team
> sections that do not describe this product. Keep it fast: no layout shift, images
> as inline SVG, Lighthouse performance and accessibility at 95 or above. Run a
> Lighthouse check and report the scores.

### Phase 7 — README as the portfolio artifact (small)

**Prompt**
> Rewrite `README.md` for a recruiter who has 30 seconds. Structure: one-line pitch,
> demo GIF, a 6-line feature list, an architecture diagram (Mermaid), the key
> decisions linked to `docs/adr/`, a "Tradeoffs and limits" section, a test matrix,
> and "Run it in 3 commands". Remove roadmap checkboxes that are already done. Keep
> it under 200 lines.

### Phase 8 — Deploy (deferred, you asked for this last)

When the phases above are merged, we will plan a serverless deployment. The
backend has in-process timers and an in-memory store, so it will need a decision
first: keep a long-running host for the engine, or move ticks and evaluation to a
scheduled job with the store in Mongo. I'll write that ADR when we get there.

---

## 4. Definition of done for the whole project

- `npm test` runs unit, contract and integration tests and passes.
- CI runs lint, tests and builds on every pull request.
- No third-party brand names, logos or people's photos remain.
- Every non-obvious decision has an ADR.
- The README's first screen shows a working product, not text.
- A reviewer can read `src/orders/engine.js` in ten minutes and understand the system.

---

## 5. Working rules for each Claude Code session

1. Start each session by reading this file and the most recent ADR.
2. Paste one phase prompt at a time. Do not combine phases.
3. Before merging, ask Claude Code to list what it did **not** change, so the scope stays honest.
4. Keep the existing integration tests green at every commit.
