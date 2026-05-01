import React from "react";
import { Link } from "react-router-dom";

const topics = [
  {
    title: "Getting Started",
    links: ["Create demo account", "Understand virtual cash", "Use watchlist"],
  },
  {
    title: "Trading",
    links: ["Place buy order", "Place sell order", "Review order history"],
  },
  {
    title: "Portfolio",
    links: ["Track holdings", "Read P&L", "Understand positions"],
  },
  {
    title: "Analytics",
    links: ["Allocation chart", "Performance summary", "Trade journal"],
  },
  {
    title: "Engineering",
    links: ["Backend API", "MongoDB models", "Deployment setup"],
  },
  {
    title: "Roadmap",
    links: ["Authentication", "Live simulation", "Risk metrics"],
  },
];

function CreateTicket() {
  return (
    <div className="container">
      <div className="row p-5 mt-5 mb-5">
        <h1 className="fs-2">Browse MarketLab help topics</h1>
        {topics.map((topic) => (
          <div className="col-4 p-5 mt-2 mb-2" key={topic.title}>
            <h4>
              <i className="fa fa-plus-circle" aria-hidden="true"></i>{" "}
              {topic.title}
            </h4>
            {topic.links.map((item) => (
              <React.Fragment key={item}>
                <Link
                  to="/support"
                  style={{ textDecoration: "none", lineHeight: "2.5" }}
                >
                  {item}
                </Link>
                <br />
              </React.Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default CreateTicket;
