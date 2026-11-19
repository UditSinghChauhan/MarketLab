import { useEffect, useState } from "react";

/**
 * False for the first frame, true right after it has been painted. Work the
 * first frame doesn't need (opening a session, the live stream, chart history)
 * waits for it, so the page's own code, fonts and first paint have the network
 * to themselves on a slow phone.
 */
export function useAfterFirstPaint(): boolean {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    // A frame callback runs just before a paint. The second one runs once the
    // first frame has been presented on screen, not merely produced.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setPainted(true);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  return painted;
}
