import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";

import { Logo } from "./ui/Logo";

// Each page loads only its own code: visitors to the landing page do not
// download the terminal, and the reverse.
const Landing = lazy(() => import("./landing/Landing").then((m) => ({ default: m.Landing })));
const TerminalRoute = lazy(() =>
  import("./terminal/Terminal").then((m) => ({ default: m.TerminalRoute })),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/terminal" element={<Navigate to="/terminal/ORBT" replace />} />
            <Route path="/terminal/:symbol" element={<TerminalRoute />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function NotFound() {
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
