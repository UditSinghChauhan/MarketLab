import React, { useState } from "react";

import BuyActionWindow from "./BuyActionWindow";

const GeneralContext = React.createContext({
  openBuyWindow: (uid, price) => {},
  openSellWindow: (uid, price) => {},
  closeBuyWindow: () => {},
});

export const GeneralContextProvider = (props) => {
  const [orderWindow, setOrderWindow] = useState({
    isOpen: false,
    mode: "BUY",
    stockUID: "",
    price: 0,
  });

  const handleOpenOrderWindow = (uid, mode, price) => {
    setOrderWindow({
      isOpen: true,
      mode,
      stockUID: uid,
      price,
    });
  };

  const handleCloseBuyWindow = () => {
    setOrderWindow({
      isOpen: false,
      mode: "BUY",
      stockUID: "",
      price: 0,
    });
  };

  return (
    <GeneralContext.Provider
      value={{
        openBuyWindow: (uid, price) => handleOpenOrderWindow(uid, "BUY", price),
        openSellWindow: (uid, price) =>
          handleOpenOrderWindow(uid, "SELL", price),
        closeBuyWindow: handleCloseBuyWindow,
      }}
    >
      {props.children}
      {orderWindow.isOpen && (
        <BuyActionWindow
          uid={orderWindow.stockUID}
          mode={orderWindow.mode}
          defaultPrice={orderWindow.price}
        />
      )}
    </GeneralContext.Provider>
  );
};

export default GeneralContext;
