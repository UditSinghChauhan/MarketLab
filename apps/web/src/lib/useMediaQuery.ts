import { useCallback, useSyncExternalStore } from "react";

const media = (query: string) =>
  typeof window.matchMedia === "function" ? window.matchMedia(query) : null;

/**
 * Whether a media query matches, read during render: the first frame is
 * already right, so nothing resizes after it paints.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = media(query);
      list?.addEventListener("change", onChange);
      return () => {
        list?.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => media(query)?.matches ?? false,
    () => false,
  );
}
