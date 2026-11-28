/**
 * The landing page's product tour: the three screens a visitor can open, each
 * shown as a real screenshot (rendered by scripts/render-assets.mjs), so the
 * product is visible to someone who reads the page without clicking through.
 *
 * It is a tab set (WAI-ARIA tabs, automatic activation): arrow keys, Home and
 * End move between tabs; only the selected screenshot is loaded until another
 * tab is hovered, focused or chosen.
 */

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";

import { prefetchOnIntent } from "../lib/routes";
import { useMediaQuery } from "../lib/useMediaQuery";

interface Screen {
  readonly key: "terminal" | "inspector" | "replay";
  readonly title: string;
  readonly summary: string;
  readonly alt: string;
  /** What the phone crop shows, which is less than the full screenshot. */
  readonly phoneAlt: string;
  readonly action: { readonly label: string; readonly to: "/terminal" | "/replay" };
}

const SCREENS: readonly Screen[] = [
  {
    key: "terminal",
    title: "Trading terminal",
    summary:
      "A candlestick chart, a live depth ladder and a keyboard-first order ticket. Click any price in the book to set a limit order.",
    alt: "The trading terminal: a candlestick chart, the order book ladder, the order ticket and a position after buying 10 shares.",
    phoneAlt:
      "The trading terminal on a phone: the order ticket just after buying 10 shares, with the order book starting below it.",
    action: { label: "Open the terminal", to: "/terminal" },
  },
  {
    key: "inspector",
    title: "Engine inspector",
    summary:
      "Any order's path through the system: received, queued, written to Postgres, matched. With the time each step took and every event it caused.",
    alt: "The engine inspector beside the terminal, tracing one order through validation, the command log write and matching, with the time of each step.",
    phoneAlt:
      "The engine inspector on a phone, tracing one order: received by the API, queued, written to the command log and matched, with the time of each step.",
    action: { label: "Place an order, then press I", to: "/terminal" },
  },
  {
    key: "replay",
    title: "Verified replay",
    summary:
      "Your browser downloads the session's seed and command log, runs the same engine in a Web Worker and checks the server's state hash after every entry.",
    alt: "The replay page: a verdict that the browser replayed the session and matched the server's state hash, above the replayed chart and order book.",
    phoneAlt:
      "The replay page on a phone: a verdict that the browser replayed the session and matched the server's state hash, above the replayed chart and the timeline.",
    action: { label: "Run the replay", to: "/replay" },
  },
];

const WIDTHS = [1120, 2240] as const;
const srcSet = (key: Screen["key"]) =>
  WIDTHS.map((w) => `/tour/${key}-${String(w)}.webp ${String(w)}w`).join(", ");
const SIZES = "(min-width: 1152px) 1104px, calc(100vw - 48px)";

/**
 * On a phone the whole terminal would be too small to read, so each screen has
 * a crop of the product at a phone's width instead (400 × 600 CSS px).
 */
const PHONE = "(max-width: 639px)";
const PHONE_WIDTHS = [800, 1200] as const;
const phoneSrcSet = (key: Screen["key"]) =>
  PHONE_WIDTHS.map((w) => `/tour/${key}-phone-${String(w)}.webp ${String(w)}w`).join(", ");
const PHONE_SIZES = "calc(100vw - 48px)";

/** Fetch a tab's screenshot before it is shown, so switching never flashes empty. */
function preload(key: Screen["key"]) {
  const phone = typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;
  const image = new Image();
  image.sizes = phone ? PHONE_SIZES : SIZES;
  image.srcset = phone ? phoneSrcSet(key) : srcSet(key);
}

export function ProductTour() {
  const [selected, setSelected] = useState(0);
  // The fade answers a choice, so the first screenshot appears without it.
  const [chosen, setChosen] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  // The same test as the <picture> source, so the text describes the image shown.
  const phone = useMediaQuery(PHONE);

  const select = (index: number, focus = false) => {
    const next = (index + SCREENS.length) % SCREENS.length;
    setSelected(next);
    setChosen(true);
    if (focus) tabs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Move from the tab that has focus (normally the selected one).
    const focused = tabs.current.findIndex((tab) => tab === document.activeElement);
    const from = focused === -1 ? selected : focused;
    const moves: Record<string, number> = {
      ArrowRight: from + 1,
      ArrowDown: from + 1,
      ArrowLeft: from - 1,
      ArrowUp: from - 1,
      Home: 0,
      End: SCREENS.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target, true);
  };

  const screen = SCREENS[selected] ?? SCREENS[0];
  if (!screen) return null;

  return (
    <section id="tour" aria-labelledby={`${id}-heading`} className="border-t border-line">
      <div className="mx-auto max-w-6xl px-6 py-28 lg:py-32">
        <h2
          id={`${id}-heading`}
          className="max-w-[26ch] text-2xl font-semibold tracking-[-0.025em] lg:text-3xl lg:tracking-[-0.03em]"
        >
          One engine, three ways to look at it.
        </h2>
        <p className="mt-5 max-w-[60ch] leading-relaxed text-muted">
          These are screenshots of the running product. Each one opens in your browser, with play
          money and no signup.
        </p>

        <div
          role="tablist"
          aria-label="Screens"
          onKeyDown={onKeyDown}
          className="mt-12 grid grid-cols-3 gap-x-3 md:gap-x-8"
        >
          {SCREENS.map((s, i) => {
            const active = i === selected;
            return (
              <button
                key={s.key}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${s.key}`}
                aria-selected={active}
                aria-controls={`${id}-panel`}
                tabIndex={active ? 0 : -1}
                onClick={() => {
                  select(i);
                }}
                onPointerEnter={() => {
                  preload(s.key);
                }}
                onFocus={() => {
                  preload(s.key);
                }}
                className={`group flex flex-col items-start justify-start border-t-2 pt-4 pb-3 text-left transition-colors duration-150 ${
                  active ? "border-accent" : "border-line hover:border-muted"
                }`}
              >
                <span
                  className={`block text-sm font-semibold md:text-base ${active ? "text-text" : "text-muted group-hover:text-text"}`}
                >
                  {s.title}
                </span>
                {/* On a phone the summary sits under the row instead, next to the screenshot it describes. */}
                <span className="mt-1.5 hidden text-sm leading-relaxed text-muted md:block">
                  {s.summary}
                </span>
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${screen.key}`}
          className="mt-6 md:mt-8"
        >
          <p className="mb-5 text-sm leading-relaxed text-muted md:hidden">{screen.summary}</p>
          <div className="dark-ui overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {/* Fixed aspect ratios (16:10, or 2:3 for the phone crop), so nothing below
                moves while the image loads. The inner hairline keeps the screenshot's
                dark edge from running into the shadow. */}
            <picture key={screen.key}>
              <source
                media={PHONE}
                srcSet={phoneSrcSet(screen.key)}
                sizes={PHONE_SIZES}
                width={400}
                height={600}
              />
              <img
                src={`/tour/${screen.key}-${String(WIDTHS[0])}.webp`}
                srcSet={srcSet(screen.key)}
                sizes={SIZES}
                width={1280}
                height={800}
                loading="lazy"
                decoding="async"
                alt={phone ? screen.phoneAlt : screen.alt}
                className={`block aspect-[16/10] h-auto w-full rounded-[11px] bg-surface outline-1 -outline-offset-1 outline-white/[0.06] max-sm:aspect-[2/3] ${chosen ? "tour-image" : ""}`}
              />
            </picture>
          </div>
          <Link
            to={screen.action.to}
            {...prefetchOnIntent(screen.action.to)}
            className="mt-6 inline-flex h-10 items-center rounded-md border border-line bg-surface px-4 text-sm font-medium hover:border-muted"
          >
            {screen.action.label}
          </Link>
        </div>
      </div>
    </section>
  );
}
