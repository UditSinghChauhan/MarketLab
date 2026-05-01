import React from "react";

const dashboardUrl = process.env.REACT_APP_DASHBOARD_URL || "http://localhost:3001";

function OpenAccount() {
  return (
    <div className="container p-5 mb-5">
      <div className="row text-center">
        <h1 className="mt-5">Create your MarketLab demo account</h1>
        <p>
          Practice paper trades, track virtual holdings, and learn portfolio
          behavior without risking real capital.
        </p>
        <a
          className="p-2 btn btn-primary fs-5 mb-5"
          href={dashboardUrl}
          style={{ width: "240px", margin: "0 auto" }}
        >
          Open dashboard
        </a>
      </div>
    </div>
  );
}

export default OpenAccount;
