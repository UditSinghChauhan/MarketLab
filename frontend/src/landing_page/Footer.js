import React from "react";
import { Link } from "react-router-dom";

const dashboardUrl = process.env.REACT_APP_DASHBOARD_URL || "http://localhost:3001";

function Footer() {
  return (
    <footer style={{ backgroundColor: "rgb(250, 250, 250)" }}>
      <div className="container border-top mt-5">
        <div className="row mt-5">
          <div className="col">
            <h3 className="fs-4 text-primary">MarketLab</h3>
            <p>&copy; 2026 MarketLab. Built as a paper trading simulator.</p>
          </div>
          <div className="col">
            <p>Product</p>
            <a href={dashboardUrl}>Trading dashboard</a>
            <br />
            <Link to="/signup">Create demo account</Link>
            <br />
          </div>
          <div className="col">
            <p>Source</p>
            <a href="https://github.com/UditSinghChauhan/MarketLab">GitHub</a>
            <br />
          </div>
        </div>
        <div className="mt-5 text-muted" style={{ fontSize: "14px" }}>
          <p>
            MarketLab is a simulated trading application for learning,
            experimentation, and portfolio demonstration. It does not execute
            real trades, provide investment advice, or connect to a live broker.
          </p>
          <p>
            Market data, wallet balances, orders, and portfolio metrics in this
            project are intended for paper trading workflows only.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
