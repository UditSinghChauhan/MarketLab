import React from "react";

function Hero() {
  return (
    <div className="container p-5 mb-5">
      <div className="row text-center">
        <img
          src="media/images/homeHero.png"
          alt="MarketLab trading dashboard preview"
          className="mb-5"
        />
        <h1 className="mt-5">Practice trading before it matters</h1>
        <p>
          MarketLab helps you place virtual trades, track holdings, and analyze
          portfolio performance in a realistic dashboard.
        </p>
        <button
          className="p-2 btn btn-primary fs-5 mb-5"
          style={{ width: "20%", margin: "0 auto" }}
        >
          Signup Now
        </button>
      </div>
    </div>
  );
}

export default Hero;
