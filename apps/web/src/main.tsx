import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

// The page is blank until React renders, so waiting a moment for the two
// preloaded font files costs nothing visible and means text never re-flows
// from a fallback font. On a slow connection the page renders after a second
// regardless.
const fonts = Promise.all(
  ["400", "600"].map((weight) => document.fonts.load(`${weight} 1em "IBM Plex Sans"`)),
);
await Promise.race([
  fonts.catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 1_000)),
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
