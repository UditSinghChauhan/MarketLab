/** The listed markets, in the order the terminal shows them. */
export const SYMBOLS = ["ORBT", "QNTA", "SOLR", "HLXB"] as const;

/** A typical price per market, used only to size placeholders so the header does not move. */
export const SAMPLE_PRICE: Record<string, string> = {
  ORBT: "1,250.00",
  QNTA: "842.50",
  SOLR: "318.20",
  HLXB: "2,140.00",
};
