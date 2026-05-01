import React from "react";

function Team() {
  return (
    <div className="container">
      <div className="row p-3 mt-5 border-top">
        <h1 className="text-center">Builder</h1>
      </div>

      <div
        className="row p-3 text-muted"
        style={{ lineHeight: "1.8", fontSize: "1.2em" }}
      >
        <div className="col-6 p-3 text-center">
          <img
            src="media/images/nithinKamath.jpg"
            style={{ borderRadius: "100%", width: "50%" }}
            alt="MarketLab project creator"
          />
          <h4 className="mt-5">Udit Singh Chauhan</h4>
          <h6>Full-stack developer</h6>
        </div>
        <div className="col-6 p-3">
          <p>
            MarketLab is built as a recruiter-facing fintech project to
            demonstrate product thinking, backend modeling, frontend workflows,
            and clean iteration.
          </p>
          <p>
            The project is moving from a static brokerage-style interface into a
            complete paper trading simulator with real portfolio behavior.
          </p>
          <p>
            Core focus areas include virtual order execution, portfolio
            analytics, authentication, deployment readiness, and maintainable
            commit history.
          </p>
        </div>
      </div>
    </div>
  );
}

export default Team;
