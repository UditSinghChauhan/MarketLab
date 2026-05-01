# MarketLab

MarketLab is a full-stack paper trading simulator for practicing stock trading with virtual capital. It includes a trading dashboard, portfolio views, watchlist UI, order placement flow, and a marketing-facing landing site inspired by modern fintech platforms.

## Features

- Stock watchlist with price movement indicators
- Buy order flow from the trading dashboard
- Holdings and positions views
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
```

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

## Roadmap

- User authentication
- Virtual wallet and cash balance
- Complete buy and sell execution engine
- Dynamic order history
- Realized and unrealized P&L tracking
- Simulated live market data
- Portfolio analytics and trade journal
- Production deployment
