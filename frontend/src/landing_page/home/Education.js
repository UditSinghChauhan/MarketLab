import React from "react";
import { Link } from "react-router-dom";

function Education() {
  return (
    <div className="container mt-5">
      <div className="row">
        <div className="col-6">
          <img
            src="media/images/education.svg"
            style={{ width: "70%" }}
            alt="Market education"
          />
        </div>
        <div className="col-6">
          <h1 className="mb-3 fs-2">Free and open market practice</h1>
          <p>
            MarketLab is designed for hands-on learning: place paper trades,
            inspect portfolio changes, and understand risk before real trading.
          </p>
          <Link to="/product" style={{ textDecoration: "none" }}>
            Explore simulator{" "}
            <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
          </Link>
          <p className="mt-5">
            The roadmap includes trade journaling, simulated live prices, and
            portfolio analytics so learners can review performance over time.
          </p>
          <Link to="/about" style={{ textDecoration: "none" }}>
            Learn about MarketLab{" "}
            <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
          </Link>
        </div>
      </div>
    </div>
  );
}

export default Education;
