# MarketLab

MarketLab is a full-stack paper trading simulator for practicing stock trading with virtual capital. It includes a trading dashboard, portfolio views, watchlist UI, order placement flow, and a marketing-facing landing site inspired by modern fintech platforms.

## Features

- Stock watchlist with price movement indicators
- Buy and sell order flow from the trading dashboard
- Demo account with virtual cash
- Signup and login with token-based sessions
- User-scoped wallet, holdings, and order history
- Holdings update after executed paper trades
- Dynamic order history, portfolio value, and P&L views
- Simulated live market feed for watchlist, indices, and portfolio repricing
- User-scoped watchlist with add/remove symbol controls
- Positions view derived from live portfolio data
- Portfolio summary cards and charts
- Recruiter demo reset for portfolio, orders, and watchlist
- Integration tests for auth, orders, watchlist, and reset flow
- Portfolio insights with exposure, concentration, P&L, and trade journal
- Loading, empty, and error states across the dashboard
- Landing pages for product, pricing, support, signup, and about sections
- Express and MongoDB backend for portfolio and order data

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
| **Dual storage** | Memory-mode for zero-config local demos; MongoDB-mode for persistence — toggled via `MONGO_URL` env var |
| **Derived positions** | Positions computed on-the-fly from holdings + live market quote — no redundant data store |
| **Price history** | Rolling 40-tick OHLC buffer per symbol in the tick engine; exposed via `/history/:symbol` and rendered as a live chart |
| **Integration tests** | 4 tests covering auth lifecycle, BUY/SELL execution, validation guards, and demo reset — run against in-process server, no database |
| **Demo reset** | Single endpoint wipes portfolio, orders, and watchlist and re-seeds to default state |

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
4. Search the watchlist, place a BUY order, then confirm cash, holdings, and orders refresh.
5. Sell part of a holding and open Insights to explain realized P&L, exposure, and the trade journal.
6. Use `Reset Demo` in the dashboard header to restore the portfolio and watchlist instantly.

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
- Production-grade JWT/session hardening
- Streamed or websocket-style market updates
- Production deployment
