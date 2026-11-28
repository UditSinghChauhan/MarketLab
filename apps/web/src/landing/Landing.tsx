import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";

import { duration, qty } from "../lib/format";
import { useExchange } from "../lib/health";
import {
  BENCHMARKS,
  COMMAND_LOG_ADR,
  DECISIONS,
  EMAIL,
  GITHUB,
  HEALTH,
  LINKEDIN,
  REPO,
  STREAM_SOURCE,
} from "../lib/links";
import { prefetchOnIntent, prefetchWhenIdle } from "../lib/routes";
import { Logo } from "../ui/Logo";
import { Architecture } from "./Architecture";
import { HeroDemo } from "./HeroDemo";
import { MatchingDiagram } from "./MatchingDiagram";
import { ProductTour } from "./ProductTour";

export function Landing() {
  // Everything on this page except the live numbers renders without the API.
  const h = useExchange().health;
  // Most visitors open the terminal next; fetch its code while they read.
  useEffect(() => prefetchWhenIdle("/terminal"), []);

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link to="/" aria-label="MarketLab home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <a href="#matching" className="hidden text-muted hover:text-text sm:inline">
            How matching works
          </a>
          <a href="#engineering" className="hidden text-muted hover:text-text sm:inline">
            Engineering
          </a>
          <Link to="/replay" className="hidden text-muted hover:text-text md:inline">
            Replay
          </Link>
          <a href={REPO} className="hidden text-muted hover:text-text sm:inline">
            Source
          </a>
          <Link
            to="/terminal"
            {...prefetchOnIntent("/terminal")}
            className="inline-flex h-9 items-center rounded-md bg-text px-3.5 text-sm font-medium text-bg hover:opacity-90"
          >
            Open the terminal
          </Link>
        </nav>
      </header>

      <main>
        {/* On a phone the live book and its button come straight after the pitch, and the
            stats follow. From lg the card sits beside the pitch and stats, which stay
            centred against it between two equal spacer rows; the section is at least as
            tall as the card (32rem plus its padding). */}
        <section className="mx-auto grid max-w-6xl gap-x-12 px-6 pb-24 pt-12 lg:min-h-[43rem] lg:grid-cols-[minmax(0,1fr)_440px] lg:grid-rows-[minmax(0,1fr)_auto_auto_minmax(0,1fr)] lg:pt-20">
          <div className="lg:col-start-1 lg:row-start-2">
            <h1 className="max-w-[16ch] text-3xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-4xl xl:text-5xl">
              A stock exchange you can watch work.
            </h1>
            <p className="mt-6 max-w-[52ch] text-lg leading-relaxed text-muted">
              MarketLab runs a real matching engine against a live order book of simulated traders.
              Place an order, then follow it through every step: validated, written to the log,
              matched, settled. Down to the microseconds the engine spent on it.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/terminal"
                {...prefetchOnIntent("/terminal")}
                className="inline-flex h-11 items-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Open the terminal
              </Link>
              <a
                href={REPO}
                className="inline-flex h-11 items-center rounded-md border border-line bg-surface px-5 text-sm font-medium hover:border-muted"
              >
                Read the source
              </a>
            </div>
          </div>
          <div className="mt-12 lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:mt-0 lg:self-center">
            <HeroDemo />
          </div>
          {/* Two shared rows (labels, values), so the values sit on one baseline however the labels wrap. */}
          <dl className="mt-12 grid max-w-lg grid-cols-3 grid-rows-[auto_auto] gap-x-6 gap-y-1 border-t border-line pt-6 lg:col-start-1 lg:row-start-3">
            <Stat
              label="Bot command, median"
              value={h ? duration(h.engine.bots.p50Us) : "—"}
              note="The simulated traders' commands: mostly quotes and cancels that never trade. A visitor's own order takes longer; the engine inspector shows both."
            />
            <Stat label="Commands this session" value={h ? qty(h.engine.commands) : "—"} />
            <Stat
              label="Invariant violations"
              value={h ? String(h.invariantViolations) : "—"}
              note="Checked live, on every load of this page"
            />
          </dl>
        </section>

        <ProductTour />

        <section id="matching" className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-28 lg:grid-cols-2 lg:py-32">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.025em] lg:text-3xl lg:tracking-[-0.03em]">
                Best price first. Then first come, first served.
              </h2>
              <p className="mt-5 max-w-[56ch] leading-relaxed text-muted">
                Every exchange needs a rule for who trades when several people want the same thing.
                MarketLab uses price-time priority, the rule most stock exchanges use.
              </p>
              <ul className="mt-8 space-y-5">
                <Rule title="A better price always goes first">
                  A buyer willing to pay ₹1,250.20 trades before one offering ₹1,250.10.
                </Rule>
                <Rule title="At the same price, the earlier order goes first">
                  Orders queue at each price in the order they arrived. Arrival is a sequence
                  number, not a clock, so two orders can never tie.
                </Rule>
                <Rule title="Trades happen at the waiting order's price">
                  If you bid ₹1,251 and the best offer is ₹1,250.30, you pay ₹1,250.30 and the
                  difference returns to your cash.
                </Rule>
              </ul>
            </div>
            <MatchingDiagram />
          </div>
        </section>

        <section id="engineering" className="mx-auto max-w-6xl px-6 py-28 lg:py-32">
          <h2 className="max-w-[24ch] text-2xl font-semibold tracking-[-0.025em] lg:text-3xl lg:tracking-[-0.03em]">
            Built the way exchanges are built, at the scale of one server.
          </h2>
          <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2">
            <Feature
              title="A deterministic engine"
              fact="About 700,000 commands a second on one core"
              evidence={BENCHMARKS}
            >
              The engine reads no clock and no random numbers, so the same inputs always produce the
              same trades. Any bug can be replayed exactly, and the simulated traders reproduce from
              a seed.
            </Feature>
            <Feature
              title="Write first, then match"
              fact={
                h && h.replay.entries > 0
                  ? `Last start replayed ${qty(h.replay.entries)} log entries in ${String(h.replay.ms)} ms`
                  : "Replays its log on every start"
              }
              evidence={COMMAND_LOG_ADR}
            >
              Each order is stored in Postgres before the engine sees it. On restart the server
              replays the log and arrives at exactly the same state. One writer holds a database
              lock, so a second copy can't corrupt it.
            </Feature>
            <Feature
              title="Money is checked, not trusted"
              fact={
                h
                  ? `${String(h.invariantViolations)} violations right now`
                  : "Audited on every health check"
              }
              evidence={HEALTH}
            >
              Cash and shares are integers of paise and shares, never floats. Property-based tests
              throw thousands of random orders at the engine and check, after every one, that no
              money is created or lost and the book never crosses.
            </Feature>
            <Feature
              title="One live connection per screen"
              fact="At most four book updates a second per viewer"
              evidence={STREAM_SOURCE}
            >
              Prices, trades and your own fills stream over server-sent events. Bursts of engine
              activity are merged into single book snapshots, and a viewer that falls behind is
              disconnected rather than allowed to grow the server's memory.
            </Feature>
            <article className="flex flex-col gap-5 bg-surface p-7 md:col-span-2 md:flex-row md:items-center md:justify-between md:gap-10">
              <div>
                <h3 className="font-semibold">Check it yourself</h3>
                <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-muted">
                  The server keeps a seed and a log of inputs, not the market. The replay page
                  downloads both, runs the same engine in a Web Worker in your browser, and compares
                  its state hash with the server's after every log entry. Then you can scrub through
                  the session.
                </p>
              </div>
              <Link
                to="/replay"
                className="inline-flex h-10 shrink-0 items-center self-start rounded-md border border-line bg-surface px-4 text-sm font-medium hover:border-muted md:self-center"
              >
                Replay this session
              </Link>
            </article>
          </div>

          <Architecture />
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-24 lg:grid-cols-[1fr_2fr] lg:py-28">
            <h2 className="text-xl font-semibold tracking-[-0.02em] lg:text-2xl lg:tracking-[-0.025em]">
              What is simulated
            </h2>
            <ul className="grid gap-x-10 gap-y-4 text-sm leading-relaxed text-muted sm:grid-cols-2">
              <li>
                The four companies are fictional, and their prices come from simulated traders, not
                a real market.
              </li>
              <li>
                Money is play money. Each visitor gets ₹10,00,000 and a guest account; there is no
                signup.
              </li>
              <li>
                About once a day, at a quiet moment, the market starts a fresh simulation and
                accounts start over.
              </li>
              <li>No fees, short selling, order amendment or time-in-force options yet.</li>
            </ul>
          </div>
        </section>

        {/* The page ends where the product starts: the terminal's own dark theme and one action. */}
        <section aria-labelledby="try-it" className="dark-ui bg-bg text-text">
          <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-24 md:flex-row md:items-end md:justify-between lg:py-28">
            <div>
              <h2
                id="try-it"
                className="text-2xl font-semibold tracking-[-0.025em] lg:text-3xl lg:tracking-[-0.03em]"
              >
                Place an order and watch where it goes.
              </h2>
              <p className="mt-4 max-w-[52ch] leading-relaxed text-muted">
                Buy, sell or rest a limit order, open the inspector to trace it, then let your
                browser replay the session and check the server's hash.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-3">
              <Link
                to="/terminal"
                {...prefetchOnIntent("/terminal")}
                className="inline-flex h-11 items-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Open the terminal
              </Link>
              <Link
                to="/replay"
                {...prefetchOnIntent("/replay")}
                className="inline-flex h-11 items-center rounded-md border border-line px-5 text-sm font-medium hover:border-muted"
              >
                Run the replay
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="dark-ui border-t border-line bg-bg">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-4 px-6 py-10 text-sm text-muted">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span>Designed and built by Udit Singh Chauhan.</span>
            <ul aria-label="Contact the author" className="flex flex-wrap gap-x-6 gap-y-2">
              <li>
                <a href={GITHUB} className="hover:text-text">
                  GitHub
                </a>
              </li>
              <li>
                <a href={LINKEDIN} className="hover:text-text">
                  LinkedIn
                </a>
              </li>
              <li>
                <a href={`mailto:${EMAIL}`} className="hover:text-text">
                  {EMAIL}
                </a>
              </li>
            </ul>
          </div>
          <ul aria-label="About this project" className="flex gap-6">
            <li>
              <a href={DECISIONS} className="hover:text-text">
                Design decisions
              </a>
            </li>
            <li>
              <a href={REPO} className="hover:text-text">
                Source code
              </a>
            </li>
          </ul>
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div title={note} className="row-span-2 grid grid-rows-subgrid">
      <dt className="self-end text-xs text-muted">{label}</dt>
      <dd className="num text-xl font-semibold tracking-[-0.02em]">{value}</dd>
    </div>
  );
}

function Rule({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-muted">{children}</p>
    </li>
  );
}

/**
 * A claim and, under it, the fact that backs it as the card's footer metric. The
 * whole line links to where it can be checked; "Evidence" says so without
 * underlining the figure.
 */
function Feature({
  title,
  fact,
  evidence,
  children,
}: {
  title: string;
  fact: string;
  evidence: string;
  children: ReactNode;
}) {
  return (
    <article className="flex flex-col bg-surface p-7">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{children}</p>
      <p className="mt-6 border-t border-line pt-4 text-sm">
        <a
          href={evidence}
          className="group flex items-baseline justify-between gap-4 rounded-sm outline-offset-4"
        >
          <span className="num font-medium text-text">{fact}</span>
          <span className="shrink-0 text-xs text-muted underline-offset-4 group-hover:text-text group-hover:underline group-focus-visible:text-text group-focus-visible:underline">
            Evidence<span aria-hidden="true"> →</span>
          </span>
        </a>
      </p>
    </article>
  );
}
