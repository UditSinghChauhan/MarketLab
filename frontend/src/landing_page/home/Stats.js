import React from "react";
import { Link } from "react-router-dom";

const dashboardUrl = process.env.REACT_APP_DASHBOARD_URL || "http://localhost:3001";

function Stats() {
  return (
    <div className="container p-3">
      <div className="row p-5">
        <div className="col-12 col-lg-6 p-5">
          <h1 className="fs-2 mb-5">Learn with confidence</h1>
          <h2 className="fs-4">Virtual capital first</h2>
          <p className="text-muted">
            Start with ₹1,00,000 of virtual cash and practice BUY/SELL
            order placement with full cash and holdings validation.
          </p>
          <h2 className="fs-4">Market, limit and stop-loss orders</h2>
          <p className="text-muted">
            Place market orders for instant execution, or limit and stop-loss
            orders that trigger automatically when the price crosses your level.
          </p>
          <h2 className="fs-4">Live P&amp;L and portfolio analytics</h2>
          <p className="text-muted">
            Watchlist, holdings, positions, funds, and an interactive price
            history chart stay together in one real-time dashboard.
          </p>
          <h2 className="fs-4">Production-grade engineering</h2>
          <p className="text-muted">
            Server-Sent Events for live feed, hand-rolled PBKDF2 auth,
            dual-mode storage (memory + MongoDB), and an in-process
            integration test suite — all without a single framework shortcut.
          </p>
        </div>
        <div className="col-12 col-lg-6 p-5 d-flex flex-column justify-content-center">
          <a href={dashboardUrl} className="mb-3" style={{ textDecoration: "none" }}>
            Open the dashboard{" "}
            <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
          </a>
          <Link to="/signup" style={{ textDecoration: "none" }}>
            Create a demo account{" "}
            <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
          </Link>
        </div>
      </div>
    </div>
  );
}

export default Stats;
