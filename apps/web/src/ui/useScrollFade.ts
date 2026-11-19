import { useEffect, useState, type CSSProperties } from "react";

const FADE = "24px";

/**
 * A horizontal row that may not fit: its edges fade out where more content is
 * scrolled away, so it is clear there is more. `activeKey` names the selected
 * item; when it changes, that item (marked with aria-current or aria-pressed)
 * is scrolled into view. Pass `attach` as the scrolling element's ref and spread `style`.
 */
export function useScrollFade(activeKey?: string) {
  const [element, attach] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    if (!element || typeof ResizeObserver !== "function") return;
    const update = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    // The observer reports every size once on observe, which sets the first state.
    const resize = new ResizeObserver(update);
    resize.observe(element);
    for (const child of element.children) resize.observe(child);
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      resize.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [element]);

  useEffect(() => {
    element
      ?.querySelector('[aria-current="page"], [aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [element, activeKey]);

  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? `transparent, #000 ${FADE}` : "#000"}, ${
          edges.end ? `#000 calc(100% - ${FADE}), transparent` : "#000"
        })`
      : undefined;
  const style: CSSProperties | undefined = mask
    ? { maskImage: mask, WebkitMaskImage: mask }
    : undefined;
  return { attach, style };
}
