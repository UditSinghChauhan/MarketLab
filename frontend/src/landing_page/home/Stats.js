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
            Practice order placement and portfolio tracking before making real
            market decisions.
          </p>
          <h2 className="fs-4">Focused dashboard</h2>
          <p className="text-muted">
            Watchlist, holdings, positions, funds, and charts stay together in
            one dashboard designed for repeated use.
          </p>
          <h2 className="fs-4">The MarketLab workflow</h2>
          <p className="text-muted">
            The project is evolving toward user wallets, full buy/sell
            execution, dynamic P&L, and simulated market data.
          </p>
          <h2 className="fs-4">Portfolio-ready engineering</h2>
          <p className="text-muted">
            Built as a MERN fintech project with clean setup docs, deployable
            apps, and an extensible trading engine roadmap.
          </p>
        </div>
        <div className="col-6 p-5">
          <img
            src="media/images/ecosystem.png"
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
