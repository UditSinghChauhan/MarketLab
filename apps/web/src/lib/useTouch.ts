import { useSyncExternalStore } from "react";

/** The same test as the `touch:` CSS variant: no hover, and a finger for a pointer. */
const QUERY = "(hover: none) and (pointer: coarse)";

const media = () => (typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

function subscribe(onChange: () => void) {
  const query = media();
  query?.addEventListener("change", onChange);
  return () => {
    query?.removeEventListener("change", onChange);
  };
}

/** True on touch screens, so copy can say "Tap" where it would say "Click". */
export function useTouch(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false,
  );
}
