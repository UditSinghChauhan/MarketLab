/**
 * Verified replay: the browser downloads the session's seed and command log,
 * runs the same engine code as the server in a Web Worker, and compares state
 * hashes. Afterwards the timeline scrubs through the session.
 */

import type { Candle, OrderBook, TradePrint } from "@marketlab/contracts";
import { paise, toDecimalString, type ReplayFrame, type Verdict } from "@marketlab/engine";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { qty, time } from "../lib/format";
import { useExchange } from "../lib/health";
import { OrderBookLadder } from "../terminal/OrderBookLadder";
import { PriceChart } from "../terminal/PriceChart";
import { SYMBOLS } from "../terminal/markets";
import { TradeTape } from "../terminal/TradeTape";
import { LogoMark } from "../ui/Logo";
import { Kbd, Panel } from "../ui/Panel";
import { StartingNotice } from "../ui/StartingNotice";
import { useScrollFade } from "../ui/useScrollFade";
import type { ReplaySnapshot } from "./protocol";
import { useReplay, type ReplayState } from "./useReplay";

const DEFAULT_SYMBOL = "ORBT";
/** Session seconds per real second. One step is one 600 ms market tick. */
const SPEEDS = [1, 10, 60] as const;
const TICK_SECONDS = 0.6;
const FRAME_MS = 100;

const rupees = (value: number): string => toDecimalString(paise(value));

/** The worker's frame (integer paise) in the shapes the terminal's components draw. */
function toViews(frame: ReplayFrame, seq: number) {
  const level = (l: { price: number; qty: number; orders: number }) => ({
    price: rupees(l.price),
    qty: l.qty,
    orders: l.orders,
  });
  const bid = frame.depth.bids[0]?.price;
  const ask = frame.depth.asks[0]?.price;
  const both = bid !== undefined && ask !== undefined;
  const book: OrderBook = {
    symbol: frame.symbol,
    seq,
    bids: frame.depth.bids.map(level),
    asks: frame.depth.asks.map(level),
    spread: both ? rupees(ask - bid) : null,
    mid: both ? rupees(Math.floor((bid + ask) / 2)) : null,
  };
  const candles: Candle[] = frame.candles.map((c) => ({
    time: c.time,
    open: rupees(c.open),
    high: rupees(c.high),
    low: rupees(c.low),
    close: rupees(c.close),
    volume: c.volume,
  }));
  const trades: TradePrint[] = frame.trades.map((t) => ({
    seq: t.seq,
    symbol: frame.symbol,
    price: rupees(t.price),
    qty: t.qty,
    aggressor: t.aggressor,
    time: t.time,
  }));
  return { book, candles, trades, last: rupees(frame.last) };
}

export function Replay() {
  const exchange = useExchange();
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const { state, seek, retry } = useReplay(symbol, exchange.state === "ready");
  const snapshot = state.phase === "replaying" || state.phase === "ready" ? state.snapshot : null;
  const ready = state.phase === "ready";
  const total = snapshot?.totalSteps ?? 0;

  // The timeline position the visitor chose; the worker follows it.
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(10);
  const position = !ready ? (snapshot?.frame.position ?? 0) : (cursor ?? total);
  const atEnd = position >= total;

  useEffect(() => {
    document.title = "Replay on MarketLab";
    const theme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previous = theme?.content;
    if (theme) theme.content = "#171E27";
    return () => {
      document.title = "MarketLab: a stock exchange you can watch work";
      if (theme && previous !== undefined) theme.content = previous;
    };
  }, []);

  const moveTo = (next: number) => {
    const clamped = Math.max(0, Math.min(total, next));
    setCursor(clamped);
    seek(Math.floor(clamped));
  };

  // Playback: advance the cursor on a timer; fractions carry over between frames.
  const moveRef = useRef(moveTo);
  const positionRef = useRef(position);
  useEffect(() => {
    moveRef.current = moveTo;
    positionRef.current = position;
  });
  useEffect(() => {
    if (!playing || !ready) return;
    const timer = setInterval(() => {
      const next = positionRef.current + (speed * FRAME_MS) / 1_000 / TICK_SECONDS;
      positionRef.current = next;
      moveRef.current(next);
      if (next >= total) setPlaying(false);
    }, FRAME_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playing, ready, speed, total]);

  const togglePlay = () => {
    if (!ready) return;
    if (!playing && atEnd) moveTo(0); // play again from the start
    setPlaying((p) => !p);
  };
  const toggleRef = useRef(togglePlay);
  useEffect(() => {
    toggleRef.current = togglePlay;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        ["INPUT", "SELECT", "BUTTON", "A", "TEXTAREA"].includes(target.tagName);
      if (event.key === " " && !typing) {
        event.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const views = useMemo(
    () => (snapshot ? toViews(snapshot.frame, snapshot.seq) : null),
    [snapshot],
  );
  const head = state.phase === "error" ? null : state.head;
  const instruments = head?.instruments ?? [];
  const name = instruments.find((i) => i.symbol === symbol)?.name;
  const { attach: attachTabs, style: tabsFade } = useScrollFade(symbol);

  return (
    <div className="dark-ui flex min-h-dvh flex-col bg-bg text-text xl:h-dvh">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-3">
        <Link
          to="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-[-0.02em]"
          aria-label="MarketLab home"
        >
          <LogoMark className="size-5 text-muted" />
          <span className="hidden sm:inline">MarketLab</span>
        </Link>
        <nav
          ref={attachTabs}
          style={tabsFade}
          aria-label="Markets"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {/* The listed markets are known up front, so the row never grows as the log loads. */}
          {(instruments.length > 0 ? instruments.map((i) => i.symbol) : SYMBOLS).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === symbol}
              onClick={() => {
                setSymbol(s);
              }}
              className={`flex h-8 shrink-0 items-center rounded-md px-2.5 text-xs font-medium ${
                s === symbol ? "bg-raised text-text" : "text-muted hover:bg-raised hover:text-text"
              }`}
            >
              {s}
            </button>
          ))}
        </nav>
        <Link
          to={`/terminal/${symbol}`}
          aria-label="Open the terminal"
          className="flex h-8 shrink-0 items-center rounded-md border border-line px-2.5 text-xs font-medium hover:bg-raised"
        >
          <span className="sm:hidden">Terminal</span>
          <span className="hidden sm:inline">Open the terminal</span>
        </Link>
      </header>

      <Status
        state={state}
        starting={exchange.state === "starting"}
        since={exchange.waitingSince}
        onRetry={retry}
      />

      <main className="grid flex-1 gap-px bg-line md:grid-cols-2 xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_300px_300px] xl:grid-rows-[minmax(0,1fr)_auto]">
        <Panel
          title={
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-text">{symbol}</span>
              <span>{name}</span>
            </span>
          }
          aside={
            <span className="num text-xs text-muted">
              {snapshot ? `As of ${time(snapshot.frame.time)}` : ""}
            </span>
          }
          className="order-1 h-[380px] md:col-span-2 xl:order-none xl:col-span-1 xl:h-auto"
          bodyClassName="flex flex-col"
        >
          <div className="flex items-baseline gap-3 px-3 pt-2">
            <span className="num text-2xl font-semibold tracking-[-0.02em]">
              {views ? priceText(views.last) : "—"}
            </span>
            <span className="ml-auto text-2xs text-muted">15-second candles</span>
          </div>
          <div className="min-h-0 flex-1 px-1 pb-1">
            <PriceChart
              candles={views?.candles ?? []}
              last={views?.last ?? null}
              onHover={noop}
              loading={!views}
            />
          </div>
        </Panel>

        <Panel title="Order book" className="order-3 xl:order-none">
          <OrderBookLadder book={views?.book ?? null} />
        </Panel>

        <div className="order-4 flex min-h-0 flex-col gap-px bg-line xl:order-none">
          <Panel title="What was checked" className="shrink-0">
            <Facts state={state} snapshot={snapshot} />
          </Panel>
          <Panel
            title="Trades"
            className="h-[280px] md:h-[400px] xl:h-auto xl:flex-1"
            bodyClassName="overflow-y-auto"
            scrollable
          >
            <TradeTape trades={views?.trades ?? []} loading={!views} />
          </Panel>
        </div>

        <section
          aria-label="Timeline"
          className="order-2 flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface px-3 py-3 md:col-span-2 xl:order-none xl:col-span-3"
        >
          <button
            type="button"
            onClick={togglePlay}
            disabled={!ready}
            className="flex h-9 w-24 items-center justify-center gap-2 rounded-md bg-accent text-sm font-semibold text-accent-ink disabled:opacity-50"
          >
            {playing ? "Pause" : "Play"}
            <Kbd>Space</Kbd>
          </button>
          <div role="group" aria-label="Playback speed" className="flex rounded-md bg-bg p-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={speed === s}
                onClick={() => {
                  setSpeed(s);
                }}
                className={`num h-7 rounded px-2.5 text-xs font-medium ${
                  speed === s ? "bg-raised text-text" : "text-muted hover:text-text"
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
          <span className="num w-[4.5rem] text-xs text-muted">
            {snapshot ? time(snapshot.startTime) : "--:--:--"}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, total)}
            step={1}
            value={Math.floor(position)}
            disabled={!ready}
            onChange={(event) => {
              setPlaying(false);
              moveTo(Number(event.target.value));
            }}
            aria-label="Position in the session"
            aria-valuetext={snapshot ? time(snapshot.frame.time) : "Not loaded"}
            className="scrubber h-9 min-w-[12rem] flex-1 disabled:opacity-50"
          />
          <span className="num w-[4.5rem] text-right text-xs text-muted">
            {snapshot ? time(snapshot.endTime) : "--:--:--"}
          </span>
          <span className="num w-full text-xs sm:w-auto">
            <span className="text-muted">Showing </span>
            {snapshot ? time(snapshot.frame.time) : "--:--:--"}
          </span>
        </section>
      </main>
    </div>
  );
}

const noop = () => undefined;
const priceText = (value: string) => {
  const [whole = "0", fraction = "00"] = value.split(".");
  return `${qty(Number(whole))}.${fraction.padEnd(2, "0")}`;
};

/** The verdict, said plainly. */
function Status({
  state,
  starting,
  since,
  onRetry,
}: {
  state: ReplayState;
  starting: boolean;
  since: number | null;
  onRetry: () => void;
}) {
  const shell =
    "flex min-h-[4.25rem] shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-raised px-3 py-3";
  if (state.phase === "error") {
    return (
      <div role="alert" className={shell}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">The replay didn't run</p>
          <p className="text-xs text-muted">{state.message}</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="h-8 rounded-md border border-line px-3 text-xs font-medium hover:bg-surface"
        >
          Try again
        </button>
      </div>
    );
  }
  if (starting && state.phase === "downloading" && !state.head) {
    return (
      <div className={shell}>
        <StartingNotice since={since} className="!max-w-none !text-left" />
      </div>
    );
  }
  if (state.phase === "downloading") {
    return (
      <div role="status" className={shell}>
        <div>
          <p className="text-sm font-semibold">Downloading the command log</p>
          <p className="num text-xs text-muted">
            {state.head
              ? `${qty(state.received)} of ${qty(state.head.seq)} entries`
              : "Asking the server for the session's seed and log"}
          </p>
        </div>
      </div>
    );
  }

  const { snapshot, head } = state;
  if (state.phase === "replaying") {
    return (
      <div className={shell}>
        <div role="status" className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Replaying the session in your browser</p>
          <p className="num text-xs text-muted">
            Log entry {qty(snapshot.seq)} of {qty(head.seq)}
          </p>
        </div>
        <progress
          aria-label="Replay progress"
          className="replay-progress h-1.5 w-full sm:w-64"
          max={Math.max(1, snapshot.totalSteps)}
          value={snapshot.frame.position}
        />
      </div>
    );
  }
  return <VerdictLine verdict={snapshot.verdict} snapshot={snapshot} shell={shell} />;
}

function VerdictLine({
  verdict,
  snapshot,
  shell,
}: {
  verdict: Verdict;
  snapshot: ReplaySnapshot;
  shell: string;
}) {
  if (verdict.status === "diverged") {
    return (
      <div role="status" className={shell}>
        <Mark tone="ask" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {verdict.seq === 0
              ? "Diverged before the first log entry"
              : `Diverged at log entry ${qty(verdict.seq)}`}
          </p>
          <p className="text-xs text-muted">
            After that entry the server recorded state hash{" "}
            <code className="font-mono text-text">{verdict.expected}</code>; this browser computed{" "}
            <code className="font-mono text-text">{verdict.actual}</code>.{" "}
            {verdict.seq > 1 ? "Every entry before it matched." : ""}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div role="status" className={shell}>
      <Mark tone="bid" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          Your browser replayed {qty(snapshot.totalCommands)} engine commands and matched the server
          exactly
        </p>
        <p className="text-xs text-muted">
          State hash{" "}
          <code className="font-mono text-text">
            {verdict.status === "verified" ? verdict.stateHash : ""}
          </code>{" "}
          after log entry {qty(verdict.status === "verified" ? verdict.seq : 0)}, computed here in{" "}
          {seconds(snapshot.elapsedMs)}.
        </p>
      </div>
    </div>
  );
}

function Mark({ tone }: { tone: "bid" | "ask" }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-7 shrink-0 place-items-center rounded-full border ${
        tone === "bid" ? "border-bid text-bid" : "border-ask text-ask"
      }`}
    >
      <svg
        viewBox="0 0 12 12"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        {tone === "bid" ? <path d="M2.5 6.5l2.5 2.5 4.5-5.5" /> : <path d="M3 3l6 6M9 3l-6 6" />}
      </svg>
    </span>
  );
}

const seconds = (ms: number) =>
  ms < 1_000 ? `${String(Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`;

function Facts({ state, snapshot }: { state: ReplayState; snapshot: ReplaySnapshot | null }) {
  const head = state.phase === "error" ? null : state.head;
  const rows: [string, string][] = [
    ["Session seed", head ? String(head.config.seed) : "—"],
    ["Log entries", head ? qty(head.seq) : "—"],
    ["Ticks and guest actions", snapshot ? qty(snapshot.totalSteps) : "—"],
    ["Engine commands at this moment", snapshot ? qty(snapshot.frame.commands) : "—"],
  ];
  return (
    <div className="p-3">
      <dl className="space-y-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-muted">{label}</dt>
            <dd className="num font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        The server stores a seed and a list of inputs, not the market. This page downloaded them and
        ran the same engine in a Web Worker; the book, chart and trades here were rebuilt in your
        browser.
      </p>
    </div>
  );
}
