import { useMediaQuery } from "./useMediaQuery";

/** The same test as the `touch:` CSS variant: no hover, and a finger for a pointer. */
const QUERY = "(hover: none) and (pointer: coarse)";

/** True on touch screens, so copy can say "Tap" where it would say "Click". */
export function useTouch(): boolean {
  return useMediaQuery(QUERY);
}
