# MarketLab

MarketLab is a full-stack paper trading simulator for practicing stock trading with virtual capital. It includes a trading dashboard, portfolio views, watchlist UI, order placement flow, and a marketing-facing landing site inspired by modern fintech platforms.

## Features

- Stock watchlist with price movement indicators and live price history charts
- Market orders for instant execution
- **Limit orders** that queue server-side and execute automatically when the market price crosses the trigger
- Demo account with ₹1,00,000 virtual cash, pre-seeded with a 5-stock diversified portfolio
- Signup and login with token-based sessions
- User-scoped wallet, holdings, and order history
- Holdings update after executed paper trades with weighted average cost
- Dynamic order history, portfolio value, unrealized and realized P&L
- Simulated live market feed over SSE for watchlist, indices, and portfolio repricing
- User-scoped watchlist with add/remove symbol controls
- Positions view derived from live portfolio data
- Portfolio allocation Doughnut chart and funds breakdown
- Recruiter demo reset — wipes and re-seeds portfolio instantly
- Integration tests for auth, orders, watchlist, limit orders, and reset flow
- Portfolio insights with the System Architecture panel
- Loading, empty, and error states across the dashboard
- Landing pages for product, pricing, support, signup, and about sections
- Rate limiting on auth and order endpoints

## Tech Stack

- React
- React Router
- Material UI
- Chart.js
- Express.js
- MongoDB and Mongoose

## Technical Highlights

| Capability | Detail |
|---|---|
| **Hand-rolled auth** | PBKDF2-SHA512 password hashing (120,000 iterations, per-user salt) and HMAC-SHA256 signed session tokens — no auth library |
| **Server-Sent Events** | Single persistent `/market-stream` connection replaces three independent polling loops, delivering live market prices and index data every 4 seconds |
| **Limit order engine** | Queued limit orders evaluated every 4 s against the live market feed; auto-executes at trigger price, auto-cancels if resources are insufficient |
| **Dual storage** | Memory-mode for zero-config local demos; MongoDB-mode for persistence — toggled via `MONGO_URL` env var |
| **Derived positions** | Positions computed on-the-fly from holdings + live market quote — no redundant data store |
| **Price history** | Rolling 40-tick OHLC buffer per symbol in the tick engine; exposed via `/history/:symbol` and rendered as a live Chart.js modal |
| **Rate limiting** | `express-rate-limit` on `/auth/*` (30 req/15 min) and `/newOrder` (30 req/min) — skipped in memory/test mode |
| **Integration tests** | 4 tests covering auth lifecycle, BUY/SELL execution, validation guards, and demo reset — run against in-process server, no database |
| **Seeded demo** | Every new account gets 5 holdings + 7 orders pre-seeded at signup so the dashboard is never blank |

## Project Structure

```text
backend/    Express API and MongoDB models
dashboard/  Trading dashboard application
frontend/   Public landing website
```

## Getting Started

Install dependencies in each app:

```bash
cd backend
npm install

cd ../dashboard
npm install

cd ../frontend
npm install
```

Create a backend environment file:

```bash
cp backend/.env.example backend/.env
cp dashboard/.env.example dashboard/.env
cp frontend/.env.example frontend/.env
```

If `MONGO_URL` is not configured, the backend starts in memory mode so the
paper trading demo can still run locally.

Start the backend:

```bash
cd backend
npm start
```

Start the dashboard:

```bash
cd dashboard
npm start
```

Start the landing site:

```bash
cd frontend
npm start
```

Run the backend integration suite:

```bash
npm test --prefix backend
```

## Recruiter Demo Flow

1. Start the backend, dashboard, and landing site in separate terminals.
2. Open the landing site and use the signup CTA to launch the dashboard.
3. Create a demo account or use the prefilled login form (`demo@marketlab.app` / `password123`).
4. Browse the watchlist, click a symbol to open the trade form, and place a **MARKET** order — watch cash, holdings, and positions update live.
5. Switch to **LIMIT** order type, set a trigger below the current price, and demonstrate how the order queues in the Orders tab and auto-executes on the next tick.
6. Open the Analytics chart from the watchlist to show the rolling OHLC price history.
7. Sell part of a holding and open Insights to explain realized P&L, the architecture panel, and the SSE connection.
8. Use `Reset Demo` in the dashboard header to restore the seeded portfolio instantly.

You can also run common commands from the repository root:

```bash
npm run install:all
npm run build
npm run serve:dashboard
npm run serve:frontend
npm run start:backend
npm run start:dashboard
npm run start:frontend
```

The served build flow is useful for interviews because the landing site can point
straight to the built dashboard using `REACT_APP_DASHBOARD_URL`.

## Demo Quality Checklist

- `npm test --prefix backend` passes the recruiter-critical API flows.
- `npm run build` compiles the dashboard and landing app.
- `GET /health` returns `MarketLab API`.
- The dashboard can run without MongoDB because the backend falls back to memory mode.
- The public landing CTA uses `REACT_APP_DASHBOARD_URL`, so it can point to a local or deployed dashboard.

## Roadmap

- Password reset and profile management
- Production-grade JWT refresh tokens
- Cloud deployment (Render / Railway)
