import React from "react";

const dashboardUrl = process.env.REACT_APP_DASHBOARD_URL || "http://localhost:3001";

function Signup() {
  return (
    <main className="signup-page">
      <div className="container">
        <div className="signup-grid">
          <section>
            <p className="hero-kicker">Demo account</p>
            <h1>Start with ₹1,00,000 in virtual capital</h1>
            <p>
              Use the dashboard login panel to create a demo profile, place
              paper trades, and show how the backend updates cash, holdings,
              orders, and analytics in real time.
            </p>
            <a className="btn btn-primary btn-lg" href={dashboardUrl}>
              Launch signup flow
            </a>
          </section>

          <section className="signup-card">
            <h2>What the recruiter can test</h2>
            <ul>
              <li>Create a user or use the prefilled demo credentials.</li>
              <li>Buy from the watchlist and watch funds update instantly.</li>
              <li>Sell partial holdings and inspect realized P&L.</li>
              <li>Open Insights to review the trade journal and metrics.</li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}

export default Signup;
