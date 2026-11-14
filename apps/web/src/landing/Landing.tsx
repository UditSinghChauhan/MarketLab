import type { ReactNode } from "react";
import { Link } from "react-router";

import { duration, qty } from "../lib/format";
import { useExchange } from "../lib/health";
import { DECISIONS, REPO } from "../lib/links";
import { Logo } from "../ui/Logo";
import { Architecture } from "./Architecture";
import { HeroDemo } from "./HeroDemo";
import { MatchingDiagram } from "./MatchingDiagram";

export function Landing() {
  // Everything on this page except the live numbers renders without the API.
  const h = useExchange().health;

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
          <a href={REPO} className="hidden text-muted hover:text-text sm:inline">
            Source
          </a>
          <Link
            to="/terminal"
            className="inline-flex h-9 items-center rounded-md bg-text px-3.5 text-sm font-medium text-bg hover:opacity-90"
          >
            Open the terminal
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-24 pt-12 lg:grid-cols-[minmax(0,1fr)_440px] lg:pt-20">
          <div>
            <h1 className="max-w-[16ch] text-3xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-4xl">
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
            <dl className="mt-12 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-6">
              <Stat label="Median matching time" value={h ? duration(h.engine.p50Us) : "—"} />
              <Stat label="Commands this session" value={h ? qty(h.engine.commands) : "—"} />
              <Stat
                label="Invariant violations"
                value={h ? String(h.invariantViolations) : "—"}
                note="Checked live, on every load of this page"
              />
            </dl>
          </div>
          <HeroDemo />
        </section>

        <section id="matching" className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-24 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.025em]">
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

        <section id="engineering" className="mx-auto max-w-6xl px-6 py-24">
          <h2 className="max-w-[24ch] text-2xl font-semibold tracking-[-0.025em]">
            Built the way exchanges are built, at the scale of one server.
          </h2>
          <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2">
            <Feature
              title="A deterministic engine"
              fact="About 700,000 commands a second on one core"
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
            >
              Cash and shares are integers of paise and shares, never floats. Property-based tests
              throw thousands of random orders at the engine and check, after every one, that no
              money is created or lost and the book never crosses.
            </Feature>
            <Feature
              title="One live connection per screen"
              fact="At most four book updates a second per viewer"
            >
              Prices, trades and your own fills stream over server-sent events. Bursts of engine
              activity are merged into single book snapshots, and a viewer that falls behind is
              disconnected rather than allowed to grow the server's memory.
            </Feature>
          </div>

          <Architecture />
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-20 lg:grid-cols-[1fr_2fr]">
            <h2 className="text-xl font-semibold tracking-[-0.02em]">What is simulated</h2>
            <ul className="grid gap-x-10 gap-y-4 text-sm leading-relaxed text-muted sm:grid-cols-2">
              <li>
                The four companies are fictional, and their prices come from simulated traders, not
                a real market.
              </li>
              <li>
                Money is play money. Each visitor gets ₹10,00,000 and a guest account; there is no
                signup.
              </li>
              <li>The market resets every 24 hours with a fresh simulation.</li>
              <li>No fees, short selling, order amendment or time-in-force options yet.</li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-10 text-sm text-muted">
        <span>Designed and built by Udit Singh Chauhan.</span>
        <span className="flex gap-6">
          <a href={DECISIONS} className="hover:text-text">
            Design decisions
          </a>
          <a href={REPO} className="hover:text-text">
            GitHub
          </a>
        </span>
      </footer>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div title={note}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num mt-1 text-xl font-semibold tracking-[-0.02em]">{value}</dd>
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

function Feature({ title, fact, children }: { title: string; fact: string; children: ReactNode }) {
  return (
    <article className="flex flex-col bg-surface p-7">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{children}</p>
      <p className="num mt-6 border-t border-line pt-4 text-sm text-accent">{fact}</p>
    </article>
  );
}
