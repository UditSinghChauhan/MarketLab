import React from "react";
import { Link } from "react-router-dom";

function Hero() {
  return (
    <section className="container-fluid" id="supportHero">
      <div className="p-5" id="supportWrapper">
        <h4>Support Portal</h4>
        <Link to="/support">Track Tickets</Link>
      </div>
      <div className="row p-5 m-3">
        <div className="col-6 p-3">
          <h1 className="fs-3">
            Search for simulator help or browse project roadmap topics
          </h1>
          <input placeholder="Eg. how does paper trading work?" />
          <br />
          <Link to="/support">Order placement</Link>
          <Link to="/support">Portfolio analytics</Link>
          <Link to="/support">Virtual funds</Link>
          <Link to="/support">Dashboard guide</Link>
        </div>
        <div className="col-6 p-3">
          <h1 className="fs-3">Featured</h1>
          <ol>
            <li>
              <Link to="/product">How MarketLab models paper trades</Link>
            </li>
            <li>
              <Link to="/about">Roadmap toward a complete simulator</Link>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}

export default Hero;
