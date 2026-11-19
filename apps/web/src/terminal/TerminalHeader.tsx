import type { AccountView, MarketSummary } from "@marketlab/contracts";
import { Link, NavLink } from "react-router";

import { changeTone, pct, price, rupees, signedRupees } from "../lib/format";
import type { ExchangeState } from "../lib/health";
import type { ConnectionStatus } from "../lib/stream";
import { LogoMark } from "../ui/Logo";
import { Kbd } from "../ui/Panel";
import { SkeletonText } from "../ui/Skeleton";
import { useScrollFade } from "../ui/useScrollFade";
import { HeaderMenu } from "./HeaderMenu";
import { SAMPLE_PRICE, SYMBOLS } from "./markets";

export function TerminalHeader({
  symbol,
  markets,
  status,
  exchange,
  account,
  inspectorOpen,
  onToggleInspector,
  onShowShortcuts,
  onStartOver,
}: {
  symbol: string;
  markets: readonly MarketSummary[];
  status: ConnectionStatus;
  exchange: ExchangeState;
  account: AccountView | null;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onShowShortcuts: () => void;
  onStartOver: () => void;
}) {
  const { attach: attachTabs, style: tabsFade } = useScrollFade(symbol);
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-3">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-semibold tracking-[-0.02em]"
        aria-label="MarketLab home"
      >
        <LogoMark className="size-5 text-muted" />
        <span className="hidden sm:inline">MarketLab</span>
      </Link>
      {/* Below 1024 px the markets sit in their own strip under the header (MarketStrip). */}
      <nav
        ref={attachTabs}
        style={tabsFade}
        aria-label="Markets"
        className="hidden min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] lg:flex"
      >
        {SYMBOLS.map((s) => {
          const m = markets.find((x) => x.symbol === s);
          return (
            <NavLink
              key={s}
              to={`/terminal/${s}`}
              className={({ isActive }) =>
                `flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs ${
                  isActive ? "bg-raised text-text" : "text-muted hover:bg-raised hover:text-text"
                }`
              }
            >
              <span className="font-medium">{s}</span>
              {/* Until 1280 px a tab shows the change; the chart heading shows this market's price. */}
              {m ? (
                <>
                  <span className="num hidden xl:inline">{price(m.last)}</span>
                  <span className={`num ${changeTone(m.changePct)}`}>{pct(m.changePct)}</span>
                </>
              ) : (
                <>
                  <span className="hidden xl:inline">
                    <SkeletonText sample={SAMPLE_PRICE[s] ?? "000.00"} />
                  </span>
                  <SkeletonText sample="+0.00%" />
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
      <div aria-hidden="true" className="flex-1 lg:hidden" />
      <div className="hidden items-center gap-5 text-xs md:flex">
        <Status status={status} exchange={exchange} />
        {account ? (
          <div className="text-right leading-tight">
            <div className="num font-medium">{rupees(account.equity)}</div>
            <div className={`num ${changeTone(account.pnl)}`}>
              {signedRupees(account.pnl)} ({pct(account.pnlPct)})
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-end gap-0.5 leading-tight">
            <SkeletonText sample="₹10,00,000.00" />
            <SkeletonText sample="₹0.00 (0.00%)" />
          </div>
        )}
      </div>
      <Link
        to="/replay"
        className="hidden h-8 items-center rounded-md px-2.5 text-xs font-medium text-muted hover:bg-raised hover:text-text xl:flex"
      >
        Replay
      </Link>
      <button
        type="button"
        onClick={onToggleInspector}
        aria-expanded={inspectorOpen}
        className="flex h-8 items-center gap-2 rounded-md border border-line px-2.5 text-xs font-medium hover:bg-raised"
      >
        Inspector <Kbd>I</Kbd>
      </button>
      <button
        type="button"
        onClick={onShowShortcuts}
        aria-label="Keyboard shortcuts"
        className="hidden h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-text sm:flex touch:hidden"
      >
        <Kbd>?</Kbd>
      </button>
      <HeaderMenu onStartOver={onStartOver} />
    </header>
  );
}

function Status({ status, exchange }: { status: ConnectionStatus; exchange: ExchangeState }) {
  const label =
    exchange === "starting"
      ? "Starting"
      : status === "live"
        ? "Live"
        : status === "connecting"
          ? "Connecting"
          : "Reconnecting";
  return (
    <span className="flex items-center gap-1.5 text-muted" role="status">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${label === "Live" ? "bg-bid" : "bg-pending"}`}
      />
      {label}
    </span>
  );
}
