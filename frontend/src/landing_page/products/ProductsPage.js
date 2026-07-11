import React from "react";

import Hero from "./Hero";
import LeftSection from "./LeftSection";
import RightSection from "./RightSection";
import Universe from "./Universe";

function ProductsPage() {
  return (
    <>
      <Hero />
      <LeftSection
        imageURL="media/images/kite.svg"
        productName="Trading Dashboard"
        productDesription="A focused workspace for watchlists, holdings, positions, funds, charts, and paper order placement."
        tryDemo="/signup"
        learnMore="/about"
        googlePlay="/product"
        appStore="/product"
      />
      <RightSection
        imageURL="media/images/console.svg"
        productName="Portfolio Console"
        productDesription="A portfolio view for tracking virtual capital, investment value, P&L, and trading activity as the simulator evolves."
        learnMore="/about"
      />
      <LeftSection
        imageURL="media/images/coin.svg"
        productName="Virtual Holdings"
        productDesription="Track simulated stock holdings and understand how quantity, average price, current value, and returns interact."
        tryDemo="/signup"
        learnMore="/pricing"
        googlePlay="/product"
        appStore="/product"
      />
      <RightSection
        imageURL="media/images/kiteconnect.svg"
        productName="Trading API"
        productDesription="Express and MongoDB APIs power orders, holdings, and positions, with a roadmap toward user wallets and complete execution flows."
        learnMore="/about"
      />
      <LeftSection
        imageURL="media/images/varsity.svg"
        productName="Learning Roadmap"
        productDesription="MarketLab is designed to grow into a practical learning product with trade journaling, simulated prices, and analytics."
        tryDemo="/signup"
        learnMore="/support"
        googlePlay="/product"
        appStore="/product"
      />
      <p className="text-center mt-5 mb-5">
        MarketLab is built as a full-stack fintech portfolio project with a
        clear roadmap from interface clone to real paper trading product.
      </p>
      <Universe />
    </>
  );
}

export default ProductsPage;
