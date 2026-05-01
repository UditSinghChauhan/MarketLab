import React from "react";

const dashboardUrl = process.env.REACT_APP_DASHBOARD_URL || "http://localhost:3001";

function Hero() {
  return (
    <div className="hero-shell">
      <div className="container">
        <div className="hero-content">
          <div>
            <p className="hero-kicker">Full-stack paper trading simulator</p>
            <h1>MarketLab</h1>
            <p>
              Practice virtual trades, track holdings, and explain portfolio
              decisions from one recruiter-ready trading dashboard.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href={dashboardUrl}>
                Open dashboard
              </a>
              <a className="btn btn-outline-primary btn-lg" href="/signup">
                Create demo account
              </a>
            </div>
          </div>

          <div className="product-preview" aria-label="MarketLab dashboard preview">
            <div className="preview-topbar">
              <span>NIFTY 50</span>
              <strong>14,230.61</strong>
              <em>+0.42%</em>
            </div>
            <div className="preview-body">
              <div className="preview-watchlist">
                {["INFY", "TCS", "RELIANCE", "WIPRO"].map((symbol, index) => (
                  <div key={symbol}>
                    <span>{symbol}</span>
                    <strong>{[1555.45, 3194.8, 2112.4, 577.75][index]}</strong>
                  </div>
                ))}
              </div>
              <div className="preview-panel">
                <span>Portfolio value</span>
                <strong>Rs. 1,04,820.50</strong>
                <div className="preview-bars">
                  <i style={{ height: "42%" }} />
                  <i style={{ height: "64%" }} />
                  <i style={{ height: "50%" }} />
                  <i style={{ height: "78%" }} />
                  <i style={{ height: "58%" }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Hero;
