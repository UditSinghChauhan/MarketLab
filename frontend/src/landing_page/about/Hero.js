import React from "react";
import { Link } from "react-router-dom";

function Hero() {
  return (
    <div className="container">
      <div className="row p-5 mt-5 mb-5">
        <h1 className="fs-2 text-center">
          MarketLab is a paper trading simulator
          <br />
          built to make portfolio learning practical.
        </h1>
      </div>

      <div
        className="row p-5 mt-5 border-top text-muted"
        style={{ lineHeight: "1.8", fontSize: "1.2em" }}
      >
        <div className="col-6 p-5">
          <p>
            MarketLab started as a fintech portfolio project and is being shaped
            into a complete stock trading simulator with virtual capital,
            watchlists, holdings, order history, and analytics.
          </p>
          <p>
            The goal is to show practical full-stack engineering around a
            finance product: clean APIs, structured data models, responsive UI,
            and realistic trading workflows.
          </p>
          <p>
            Users can explore how trades affect a portfolio without connecting
            to a broker or risking real money.
          </p>
        </div>
        <div className="col-6 p-5">
          <p>
            The roadmap includes authentication, per-user wallets, buy and sell
            execution, dynamic P&L, simulated live prices, and trade journaling.
          </p>
          <p>
            <Link to="/product" style={{ textDecoration: "none" }}>
              Explore the platform
            </Link>{" "}
            to see the product modules this project is designed around.
          </p>
          <p>
            MarketLab is intentionally educational: it focuses on explaining the
            behavior of trading systems rather than pretending to be a broker.
          </p>
        </div>
      </div>
    </div>
  );
}

export default Hero;
