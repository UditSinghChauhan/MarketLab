import React from "react";
import { Link } from "react-router-dom";

function Brokerage() {
  return (
    <div className="container">
      <div className="row p-5 mt-5 text-center border-top">
        <div className="col-8 p-4">
          <Link to="/product" style={{ textDecoration: "none" }}>
            <h3 className="fs-5">Simulator assumptions</h3>
          </Link>
          <ul
            style={{ textAlign: "left", lineHeight: "2.5", fontSize: "12px" }}
            className="text-mut"
          >
            <li>Orders are paper trades and do not execute on an exchange.</li>
            <li>Virtual balances are used for learning and demo workflows.</li>
            <li>Brokerage, margin, and P&L values are sample calculations.</li>
            <li>Future versions will support configurable fees and taxes.</li>
            <li>MarketLab does not provide financial advice.</li>
          </ul>
        </div>
        <div className="col-4 p-4">
          <Link to="/support" style={{ textDecoration: "none" }}>
            <h3 className="fs-5">Roadmap and help</h3>
          </Link>
        </div>
      </div>
    </div>
  );
}

export default Brokerage;
