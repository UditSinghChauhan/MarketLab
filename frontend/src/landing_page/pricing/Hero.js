import React from "react";

function Hero() {
  return (
    <div className="container">
      <div className="row p-5 mt-5 border-bottom text-center">
        <h1>Pricing</h1>
        <h3 className="text-muted mt-3 fs-5">
          Virtual capital, paper brokerage assumptions, and zero real-money risk
        </h3>
      </div>
      <div className="row p-5 mt-5 text-center">
        <div className="col-4 p-4">
          <img src="media/images/pricingEquity.svg" alt="Virtual delivery" />
          <h1 className="fs-3">Free paper delivery</h1>
          <p className="text-muted">
            Practice equity delivery flows with simulated holdings and no real
            brokerage.
          </p>
        </div>
        <div className="col-4 p-4">
          <img src="media/images/intradayTrades.svg" alt="Intraday practice" />
          <h1 className="fs-3">Intraday assumptions</h1>
          <p className="text-muted">
            Model intraday trades with configurable sample brokerage and margin
            assumptions.
          </p>
        </div>
        <div className="col-4 p-4">
          <img src="media/images/pricingEquity.svg" alt="Portfolio analytics" />
          <h1 className="fs-3">Analytics included</h1>
          <p className="text-muted">
            Track P&L, portfolio value, allocation, and performance as the
            simulator evolves.
          </p>
        </div>
      </div>
    </div>
  );
}

export default Hero;
