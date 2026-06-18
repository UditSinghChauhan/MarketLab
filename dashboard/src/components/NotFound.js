import React from "react";
import { Link } from "react-router-dom";

const NotFound = () => {
  return (
    <div className="not-found">
      <div className="not-found-inner">
        <span className="not-found-code">404</span>
        <h2>Page not found</h2>
        <p>The page you're looking for doesn't exist or has been moved.</p>
        <Link to="/" className="btn btn-blue">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
