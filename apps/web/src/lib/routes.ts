/**
 * Pages that load on demand. The router and prefetching share these imports,
 * so a prefetched page is the very chunk the router later renders; the module
 * cache keeps one copy however often they are called.
 */
export const loadTerminal = () => import("../terminal/Terminal");
export const loadReplay = () => import("../replay/Replay");

/** Starts downloading the code for a path's page, if it has its own chunk. */
export function prefetchPage(pathname: string): void {
  if (pathname.startsWith("/terminal")) void loadTerminal();
  else if (pathname.startsWith("/replay")) void loadReplay();
}

/** Handlers for a link to a lazily loaded page: its code starts loading on hover or focus. */
export function prefetchOnIntent(pathname: string) {
  const prefetch = () => {
    prefetchPage(pathname);
  };
  return { onPointerEnter: prefetch, onFocus: prefetch };
}

/** After the current page has loaded, so a prefetch never competes with it. */
const SETTLE_MS = 2_000;

/**
 * Prefetches a page once the current one has finished loading and the browser
 * is idle, unless the visitor asked to save data. Returns a cancel function
 * for effect cleanup.
 */
export function prefetchWhenIdle(pathname: string): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => undefined;

  let timer: number | undefined;
  let idle: number | undefined;
  const prefetch = () => {
    prefetchPage(pathname);
  };
  const schedule = () => {
    timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(prefetch, { timeout: 2_000 });
      } else prefetch();
    }, SETTLE_MS);
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });

  return () => {
    window.removeEventListener("load", schedule);
    window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
