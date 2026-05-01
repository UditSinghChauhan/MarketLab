# MarketLab

MarketLab is a full-stack paper trading simulator for practicing stock trading with virtual capital. It includes a trading dashboard, portfolio views, watchlist UI, order placement flow, and a marketing-facing landing site inspired by modern fintech platforms.

## Features

- Stock watchlist with price movement indicators
- Buy and sell order flow from the trading dashboard
- Demo account with virtual cash
- Holdings update after executed paper trades
- Dynamic order history, portfolio value, and P&L views
- Portfolio summary cards and charts
- Landing pages for product, pricing, support, signup, and about sections
- Express and MongoDB backend for portfolio and order data

## Tech Stack

- React
- React Router
- Material UI
- Chart.js
- Express.js
- MongoDB and Mongoose

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

You can also run common commands from the repository root:

```bash
npm run install:all
npm run build
npm run start:backend
npm run start:dashboard
npm run start:frontend
```

## Roadmap

- User authentication
- Per-user persistent wallets
- Order validation test suite
- Simulated live market data
- Portfolio analytics and trade journal
- Production deployment
