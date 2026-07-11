import React from "react";

function Awards() {
  return (
    <div className="container mt-5">
      <div className="row">
        <div className="col-6 p-5">
          <img
            src="media/images/largestBroker.svg"
            alt="MarketLab paper trading workflow"
          />
        </div>
        <div className="col-6 p-5 mt-5">
          <h1>Built for practical market learning</h1>
          <p className="mb-5">
            MarketLab gives beginners and student developers a realistic place
            to understand how orders, holdings, and portfolio performance work.
          </p>
          <div className="row">
            <div className="col-6">
              <ul>
                <li>
                  <p>Paper equity orders</p>
                </li>
                <li>
                  <p>Virtual portfolio tracking</p>
                </li>
                <li>
                  <p>Watchlist monitoring</p>
                </li>
              </ul>
            </div>
            <div className="col-6">
              <ul>
                <li>
                  <p>Holdings and positions</p>
                </li>
                <li>
                  <p>Dashboard charts</p>
                </li>
                <li>
                  <p>Order history roadmap</p>
                </li>
              </ul>
            </div>
          </div>
          <img
            src="media/images/pressLogos.svg"
            style={{ width: "90%" }}
            alt="MarketLab platform integrations"
          />
        </div>
      </div>
    </div>
  );
}

export default Awards;
