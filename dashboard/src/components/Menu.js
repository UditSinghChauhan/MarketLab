import React, { useEffect, useState } from "react";

import { Link, useLocation } from "react-router-dom";
import { getStoredUser } from "../config/auth";

const Menu = () => {
  const location = useLocation();
  const [currentUser, setCurrentUser] = useState(getStoredUser());

  useEffect(() => {
    const syncUser = () => setCurrentUser(getStoredUser());

    window.addEventListener("marketlab:auth-changed", syncUser);

    return () => {
      window.removeEventListener("marketlab:auth-changed", syncUser);
    };
  }, []);

  const menuClass = "menu";
  const activeMenuClass = "menu selected";
  const menuItems = [
    { label: "Dashboard", to: "/" },
    { label: "Orders", to: "/orders" },
    { label: "Holdings", to: "/holdings" },
    { label: "Positions", to: "/positions" },
    { label: "Funds", to: "/funds" },
    { label: "Insights", to: "/apps" },
  ];
  const avatarLabel = currentUser?.name
    ? currentUser.name
        .split(" ")
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase()
    : "ML";

  return (
    <div className="menu-container">
      <img src="logo.png" style={{ width: "50px" }} alt="MarketLab" />
      <div className="menus">
        <ul>
          {menuItems.map((item) => {
            const isSelected = location.pathname === item.to;

            return (
              <li key={item.to}>
                <Link style={{ textDecoration: "none" }} to={item.to}>
                  <p className={isSelected ? activeMenuClass : menuClass}>
                    {item.label}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
        <hr />
        <div className="profile">
          <div className="avatar">{avatarLabel}</div>
          <p className="username">{currentUser?.name || "DEMO"}</p>
        </div>
      </div>
    </div>
  );
};

export default Menu;
