import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router";

import { Landing } from "./landing/Landing";
import { loadReplay, loadTerminal } from "./lib/routes";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { Logo } from "./ui/Logo";

// The landing page is the first thing most visitors see, so it ships in the
// main bundle. The terminal and the replay are their own chunks: the server
// preloads the right one from the page's HTML, main.tsx starts it before the
// first render, and the landing page prefetches the terminal (see lib/routes).
const TerminalRoute = lazy(() => loadTerminal().then((m) => ({ default: m.TerminalRoute })));

const Replay = lazy(() => loadReplay().then((m) => ({ default: m.Replay })));

export function App() {
  return (
    <BrowserRouter>
      <Pages />
    </BrowserRouter>
  );
}

function Pages() {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname}>
      <Suspense fallback={<div className="dark-ui min-h-dvh bg-bg" />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/terminal" element={<Navigate to="/terminal/ORBT" replace />} />
          <Route path="/terminal/:symbol" element={<TerminalRoute />} />
          <Route path="/replay" element={<Replay />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

function NotFound() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Page not found · MarketLab";
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-sm text-center">
        <Logo className="text-lg" />
        <h1 className="mt-8 text-xl font-semibold">This page doesn't exist</h1>
        <p className="mt-2 text-muted">The market is still open, though.</p>
        <Link
          to="/terminal"
          className="mt-6 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink"
        >
          Open the terminal
        </Link>
      </div>
    </main>
  );
}
