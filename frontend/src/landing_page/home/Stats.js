import React from "react";
import { Link } from "react-router-dom";

function Stats() {
  return (
    <div className="container p-3">
      <div className="row p-5">
        <div className="col-6 p-5">
          <h1 className="fs-2 mb-5">Learn with confidence</h1>
          <h2 className="fs-4">Virtual capital first</h2>
          <p className="text-muted">
            Start with ₹1,00,000 of virtual cash and practice BUY/SELL
            order placement with full cash and holdings validation.
          </p>
          <h2 className="fs-4">Market &amp; Limit orders</h2>
          <p className="text-muted">
            Place market orders for instant execution or limit orders that
            trigger automatically when the market price crosses your target.
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
        <div className="col-6 p-5">
          <img
            src="media/images/ecosystem.svg"
            style={{ width: "90%" }}
            alt="MarketLab dashboard ecosystem"
          />
          <div className="text-center">
            <Link
              to="/product"
              className="mx-5"
              style={{ textDecoration: "none" }}
            >
              Explore platform{" "}
              <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
            </Link>
            <Link to="/signup" style={{ textDecoration: "none" }}>
              Start demo{" "}
              <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Stats;
