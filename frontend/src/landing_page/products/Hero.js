import React from "react";
import { Link } from "react-router-dom";

function Hero() {
  return (
    <div className="container border-bottom mb-5">
      <div className="text-center mt-5 p-3">
        <h1>Platform</h1>
        <h3 className="text-muted mt-3 fs-4">
          A focused paper trading workspace for learning the market
        </h3>
        <p className="mt-3 mb-5">
          Check out the{" "}
          <Link to="/pricing" style={{ textDecoration: "none" }}>
            virtual pricing model{" "}
            <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
          </Link>
        </p>
      </div>
    </div>
  );
}

export default Hero;
