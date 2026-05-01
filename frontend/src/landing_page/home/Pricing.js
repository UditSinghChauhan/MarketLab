import React from "react";
import { Link } from "react-router-dom";

function Pricing() {
  return (
    <div className="container">
      <div className="row">
        <div className="col-4">
          <h1 className="mb-3 fs-2">Simple virtual pricing</h1>
          <p>
            MarketLab uses virtual capital and paper brokerage assumptions so
            users can focus on learning order flow and portfolio behavior.
          </p>
          <Link to="/pricing" style={{ textDecoration: "none" }}>
            See Pricing{" "}
            <i className="fa fa-long-arrow-right" aria-hidden="true"></i>
          </Link>
        </div>
        <div className="col-2"></div>
        <div className="col-6  mb-5">
          <div className="row text-center">
            <div className="col p-3 border">
              <h1 className="mb-3">Rs. 0</h1>
              <p>
                Virtual account setup and
                <br />
                paper delivery practice
              </p>
            </div>
            <div className="col p-3 border">
              <h1 className="mb-3">Rs. 20</h1>
              <p>Sample intraday brokerage assumption</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Pricing;
