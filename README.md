# MarketLab

[![CI](https://github.com/UditSinghChauhan/MarketLab/actions/workflows/ci.yml/badge.svg)](https://github.com/UditSinghChauhan/MarketLab/actions/workflows/ci.yml)

MarketLab is a full-stack paper trading platform with a public landing site, a trading dashboard, and an Express backend. It lets users create an account, manage a simulated portfolio, place paper trades, track holdings, view order history, and receive simulated live market updates.

This project is inspired by modern brokerage platforms, but it is not affiliated with Zerodha or any real broker. Market prices and trades are simulated.

## Features

- Public landing website with home, products, pricing, support, signup, and about pages.
- User signup and login with token-based sessions.
- Seeded demo account with virtual cash, holdings, and order history.
- Trading dashboard with watchlist, holdings, positions, funds, orders, and summary views.
- Market BUY/SELL orders with cash and holdings validation.
- Limit BUY/SELL orders that stay pending until the simulated price reaches the trigger.
- Pending limit order cancellation.
- User-specific watchlists with add and remove actions.
- Simulated live market and index updates through Server-Sent Events.
- Portfolio metrics including cash, invested value, current value, realized P&L, and unrealized P&L.
- Rolling OHLC price history for supported symbols.
- Optional MongoDB persistence with an in-memory fallback for local use.
- Backend integration tests for auth, orders, watchlist, reset, and cancellation flows.

## Tech Stack

| Area | Technology |
| --- | --- |
| Landing site | React, React Router |
| Dashboard | React, React Router, Material UI, Axios, Chart.js |
| Backend | Node.js, Express |
| Database | MongoDB, Mongoose |
| Realtime updates | Server-Sent Events |
| Authentication | PBKDF2 password hashing, HMAC-signed session tokens |
| Testing | Node.js integration tests |

## Project Structure

```text
.
|-- backend/      Express API, auth, data models, market simulator
|-- dashboard/    Trading dashboard React app
|-- frontend/     Public landing React app
|-- scripts/      Local utility scripts
`-- package.json  Root scripts for install, build, and app startup
```

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm
- MongoDB, optional

The backend runs in memory when `MONGO_URL` is not set, so MongoDB is not required for basic local development.

### Install Dependencies

```bash
npm run install:all
```

### Environment Variables

Create local environment files:

```bash
cp backend/.env.example backend/.env
cp dashboard/.env.example dashboard/.env
cp frontend/.env.example frontend/.env
```

PowerShell:

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item dashboard/.env.example dashboard/.env
Copy-Item frontend/.env.example frontend/.env
```

Backend variables:

```env
PORT=3002
AUTH_SECRET=change-me
MONGO_URL=mongodb://localhost:27017/marketlab
```

`MONGO_URL` can be omitted to use in-memory storage.

Dashboard variables:

```env
REACT_APP_API_URL=http://localhost:3002
```

Landing site variables:

```env
REACT_APP_DASHBOARD_URL=http://localhost:3001
```

### Run Locally

Start the backend:

```bash
npm run start:backend
```

Start the dashboard:

```bash
npm run start:dashboard
```

Start the landing site:

```bash
npm run start:frontend
```

Default URLs:

| App | URL |
| --- | --- |
| Landing site | `http://localhost:3000` |
| Dashboard | `http://localhost:3001` |
| Backend API | `http://localhost:3002` |

Demo account:

```text
Email: demo@marketlab.app
Password: password123
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run install:all` | Install dependencies for backend, dashboard, and frontend |
| `npm run start:backend` | Start the Express API |
| `npm run start:dashboard` | Start the dashboard React app |
| `npm run start:frontend` | Start the landing React app |
| `npm run build` | Build dashboard and landing apps |
| `npm run serve:dashboard` | Serve the dashboard production build locally |
| `npm run serve:frontend` | Serve the landing site production build locally |
| `npm test --prefix backend` | Run backend integration tests |

## API Overview

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | API health check |
| `POST` | `/auth/signup` | Create a user account |
| `POST` | `/auth/login` | Login and return a session token |
| `GET` | `/auth/me` | Return the current authenticated user |
| `GET` | `/account` | Return account balance and portfolio summary |
| `GET` | `/allHoldings` | Return current holdings |
| `GET` | `/allPositions` | Return derived open positions |
| `GET` | `/allOrders` | Return order history |
| `POST` | `/newOrder` | Place a market or limit order |
| `DELETE` | `/orders/:id/cancel` | Cancel a pending limit order |
| `GET` | `/watchlist` | Return watchlist and available symbols |
| `POST` | `/watchlist` | Add a symbol to the watchlist |
| `DELETE` | `/watchlist/:symbol` | Remove a symbol from the watchlist |
| `GET` | `/market-feed` | Return current simulated market data |
| `GET` | `/market-stream` | Stream simulated market and index updates |
| `GET` | `/indices` | Return simulated index data |
| `GET` | `/history/:symbol` | Return rolling price history for a symbol |
| `POST` | `/demo/reset` | Reset the current user's seeded demo data |

## Testing

Run the backend integration suite:

```bash
npm test --prefix backend
```

The tests run against the Express app in memory mode and cover:

- signup and session restore
- market BUY/SELL order execution
- invalid order validation
- watchlist updates
- demo reset
- limit order creation and cancellation

## Build

```bash
npm run build
```

This builds both React apps:

- `dashboard/build`
- `frontend/build`

## Implementation Notes

- The backend uses in-memory storage when `MONGO_URL` is missing.
- New users are seeded with demo holdings and orders so the dashboard has initial data.
- Market data is generated by a local simulator and updated on an interval.
- The dashboard consumes live market updates from a single `EventSource` connection.
- Positions and portfolio totals are derived from account cash, holdings, orders, and current simulated prices.
- Limit orders are evaluated periodically against the simulated market price.

## Limitations

- Market prices are simulated and are not suitable for real trading decisions.
- There is no real broker, exchange, or payment integration.
- The order engine does not model partial fills, slippage, fees, taxes, or settlement.
- Session handling is simplified for a portfolio project and should be hardened before production use.
- Frontend automated tests are not currently included.

## Roadmap

- Add frontend tests for dashboard workflows.
- Add Docker Compose for local multi-service setup.
- Add deployment configuration.
- Add brokerage fees, charges, and trade exports.
- Add richer portfolio analytics and historical performance charts.

## License

This project is intended for educational use.
