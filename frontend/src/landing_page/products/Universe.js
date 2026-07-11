import React from "react";
import { Link } from "react-router-dom";

const modules = [
  "Watchlist",
  "Paper Orders",
  "Holdings",
  "Positions",
  "Funds",
  "Analytics",
];

function Universe() {
  return (
    <div className="container mt-5">
      <div className="row text-center">
        <h1>The MarketLab Toolkit</h1>
        <p>
          A modular trading simulator that can grow from a dashboard into a
          complete fintech product.
        </p>

        {modules.map((module) => (
          <div className="col-4 p-3 mt-5" key={module}>
            <img src="media/images/smallcaseLogo.png" alt={`${module} module`} />
            <p className="small text-muted">{module}</p>
          </div>
        ))}
        <Link
          className="p-2 btn btn-primary fs-5 mb-5"
          style={{ width: "20%", margin: "0 auto" }}
          to="/signup"
        >
          Signup Now
        </Link>
      </div>
    </div>
  );
}

export default Universe;
