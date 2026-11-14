import type { Candle, CommandResult, EventView, OrderView } from "@marketlab/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Navigate, useParams } from "react-router";

import { ApiRequestError, api } from "../lib/api";
import { changeTone, pct, price, qty, rupees, signedRupees } from "../lib/format";
import { sideLabel } from "../lib/orders";
import { clearSession, ensureSession, storedSession } from "../lib/session";
import { useMarketStream, type ConnectionStatus } from "../lib/stream";
import { LogoMark } from "../ui/Logo";
import { Kbd, Panel } from "../ui/Panel";
import { Blotter } from "./Blotter";
import { Inspector } from "./Inspector";
import { OrderBookLadder } from "./OrderBookLadder";
import { OrderTicket, isField, type Prefill } from "./OrderTicket";
import { PriceChart } from "./PriceChart";
import { TradeTape } from "./TradeTape";

export const SYMBOLS = ["ORBT", "QNTA", "SOLR", "HLXB"] as const;

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "info";
}

export function TerminalRoute() {
  const { symbol = "ORBT" } = useParams();
  const upper = symbol.toUpperCase();
  if (!(SYMBOLS as readonly string[]).includes(upper))
    return <Navigate to="/terminal/ORBT" replace />;
  return <Terminal symbol={upper} />;
}

function Terminal({ symbol }: { symbol: string }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState(storedSession);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const token = session?.token ?? null;

  const startSession = useCallback(() => {
    ensureSession()
      .then((s) => {
        setSession(s);
        setSessionError(null);
      })
      .catch((error: unknown) => {
        setSessionError(
          error instanceof ApiRequestError
            ? error.message
            : "The exchange isn't reachable right now.",
        );
      });
  }, []);

  useEffect(() => {
    if (!session) startSession();
  }, [session, startSession]);

  const renewSession = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  const market = useMarketStream(symbol, token, renewSession);
  const summary = market.markets.find((m) => m.symbol === symbol);

  const orders = useQuery({
    queryKey: ["orders", token],
    queryFn: async () => {
      try {
        return await api<OrderView[]>("/api/orders", { token });
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) renewSession();
        throw error;
      }
    },
    enabled: token !== null,
  });
  const orderList = useMemo(() => orders.data ?? [], [orders.data]);

  useEffect(() => {
    if (market.ordersVersion > 0) void queryClient.invalidateQueries({ queryKey: ["orders"] });
  }, [market.ordersVersion, queryClient]);

  // Toasts for things that happen to the user's orders while they look elsewhere.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const ownSeqs = useRef(new Set<number>());
  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4_000);
  }, []);

  // Orders are read through a ref so a refreshed order list doesn't replay old toasts.
  const ordersRef = useRef(orderList);
  useEffect(() => {
    ordersRef.current = orderList;
  }, [orderList]);
  useEffect(() => {
    const later = market.lastOrderEvents.filter((e) => !ownSeqs.current.has(e.seq));
    for (const event of later) {
      const message = describeAsync(event, ordersRef.current);
      if (message) toast(message);
    }
  }, [market.lastOrderEvents, toast]);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspected, setInspected] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [hovered, setHovered] = useState<Candle | null>(null);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isField(event.target)) return;
      if (event.key === "i" || event.key === "I") {
        event.preventDefault();
        setInspectorOpen((o) => !o);
      }
      if (event.key === "?") setShortcutsOpen((o) => !o);
      if (event.key === "Escape") setShortcutsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const onResult = (result: CommandResult) => {
    for (const e of result.events) ownSeqs.current.add(e.seq);
    if (result.orderId) setInspected(result.orderId);
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
  };

  const cancel = async (id: string) => {
    setCancelling((s) => new Set(s).add(id));
    try {
      const result = await api<CommandResult>(`/api/orders/${id}`, { method: "DELETE", token });
      for (const e of result.events) ownSeqs.current.add(e.seq);
      toast("Order cancelled", "info");
    } catch (error) {
      toast(
        error instanceof ApiRequestError ? error.message : "Couldn't cancel that order.",
        "info",
      );
    } finally {
      setCancelling((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    }
  };

  const myPrices = useMemo(() => {
    const buy = new Set<string>();
    const sell = new Set<string>();
    for (const o of orderList) {
      if (o.symbol === symbol && o.status === "resting" && o.price)
        (o.side === "buy" ? buy : sell).add(o.price);
    }
    return { buy, sell };
  }, [orderList, symbol]);

  const account = market.account;
  const shown = hovered ?? null;

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
        <nav aria-label="Markets" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {SYMBOLS.map((s) => {
            const m = market.markets.find((x) => x.symbol === s);
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
                {m && (
                  <>
                    <span className="num">{price(m.last)}</span>
                    <span className={`num ${changeTone(m.changePct)}`}>{pct(m.changePct)}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="hidden items-center gap-5 text-xs md:flex">
          {account && (
            <div className="text-right leading-tight">
              <div className="num font-medium">{rupees(account.equity)}</div>
              <div className={`num ${changeTone(account.pnl)}`}>
                {signedRupees(account.pnl)} ({pct(account.pnlPct)})
              </div>
            </div>
          )}
          <Status status={market.status} />
        </div>
        <button
          type="button"
          onClick={() => {
            setInspectorOpen((o) => !o);
          }}
          aria-expanded={inspectorOpen}
          className="flex h-8 items-center gap-2 rounded-md border border-line px-2.5 text-xs font-medium hover:bg-raised"
        >
          Inspector <Kbd>I</Kbd>
        </button>
        <button
          type="button"
          onClick={() => {
            setShortcutsOpen((o) => !o);
          }}
          aria-label="Keyboard shortcuts"
          className="hidden h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-text sm:flex"
        >
          <Kbd>?</Kbd>
        </button>
      </header>

      {sessionError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 border-b border-line bg-raised px-4 py-2 text-sm"
        >
          <span>{sessionError}</span>
          <button type="button" onClick={startSession} className="text-accent hover:underline">
            Try again
          </button>
        </div>
      )}

      <main className="grid flex-1 gap-px bg-line md:grid-cols-2 xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_300px_300px] xl:grid-rows-[minmax(0,1fr)_248px]">
        <Panel
          title={
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-text">{symbol}</span>
              <span>{summary?.name}</span>
            </span>
          }
          aside={
            <span className="num flex gap-3 text-xs text-muted">
              {shown ? (
                <>
                  <span>O {price(shown.open)}</span>
                  <span>H {price(shown.high)}</span>
                  <span>L {price(shown.low)}</span>
                  <span>C {price(shown.close)}</span>
                  <span>Vol {qty(shown.volume)}</span>
                </>
              ) : summary ? (
                <>
                  <span className="hidden sm:inline">Open {price(summary.open)}</span>
                  <span className="hidden sm:inline">High {price(summary.high)}</span>
                  <span className="hidden sm:inline">Low {price(summary.low)}</span>
                  <span>Vol {qty(summary.volume)}</span>
                </>
              ) : null}
            </span>
          }
          className="order-1 h-[420px] md:col-span-2 xl:order-none xl:col-span-1 xl:h-auto"
          bodyClassName="flex flex-col"
        >
          <div className="flex items-baseline gap-3 px-3 pt-2">
            <span className="num text-2xl font-semibold tracking-[-0.02em]">
              {price(summary?.last)}
            </span>
            {summary && (
              <span className={`num text-sm ${changeTone(summary.changePct)}`}>
                {signedRupees(summary.change)} ({pct(summary.changePct)})
              </span>
            )}
            <span className="ml-auto text-2xs text-muted">15-second candles</span>
          </div>
          <div className="min-h-0 flex-1 px-1 pb-1">
            <PriceChart
              candles={market.candles}
              last={summary?.last ?? null}
              onHover={setHovered}
            />
          </div>
        </Panel>

        <Panel
          title="Order book"
          aside={<span className="text-2xs text-muted">Click a price to use it</span>}
          className="order-3 xl:order-none xl:row-span-2"
        >
          <OrderBookLadder
            book={market.book}
            myPrices={myPrices}
            onPick={(p, side) => {
              setPrefill({ price: p, side, nonce: Date.now() });
            }}
          />
        </Panel>

        <Panel
          title="Place an order"
          className="order-2 xl:order-none"
          bodyClassName="overflow-y-auto"
        >
          <OrderTicket
            market={summary}
            account={account}
            token={token}
            prefill={prefill}
            onResult={onResult}
          />
        </Panel>

        <div className="order-5 flex h-[320px] md:col-span-2 xl:order-none xl:col-span-1 xl:col-start-1 xl:row-start-2 xl:h-auto">
          <Blotter
            account={account}
            orders={orderList}
            onCancel={(id) => void cancel(id)}
            onInspect={(id) => {
              setInspected(id);
              setInspectorOpen(true);
            }}
            cancelling={cancelling}
          />
        </div>

        <Panel
          title="Trades"
          className="order-4 h-[320px] xl:order-none xl:col-start-3 xl:row-start-2 xl:h-auto"
          bodyClassName="overflow-y-auto"
        >
          <TradeTape trades={market.trades} />
        </Panel>
      </main>

      <Inspector
        open={inspectorOpen}
        onClose={() => {
          setInspectorOpen(false);
        }}
        orders={orderList}
        selectedId={inspected}
        onSelect={setInspected}
        token={token}
        version={market.ordersVersion}
      />

      {shortcutsOpen && (
        <Shortcuts
          onClose={() => {
            setShortcutsOpen(false);
          }}
        />
      )}

      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 left-4 z-40 flex flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-md border border-line bg-raised px-3 py-2 text-sm shadow-lg ${t.tone === "ok" ? "text-text" : "text-muted"}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Status({ status }: { status: ConnectionStatus }) {
  const label =
    status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span className="flex items-center gap-1.5 text-muted" role="status">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${status === "live" ? "bg-bid" : "bg-pending"}`}
      />
      {label}
    </span>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["B / S", "Buy or sell"],
    ["M / L / T", "Market, limit or stop order"],
    ["Enter", "Place the order"],
    ["Esc", "Clear the ticket"],
    ["↑ / ↓", "Move a price by one tick"],
    ["I", "Open or close the engine inspector"],
    ["?", "Show these shortcuts"],
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-5"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2 className="mb-4 text-sm font-semibold">Keyboard shortcuts</h2>
        <dl className="space-y-2 text-sm">
          {rows.map(([keys, action]) => (
            <div key={keys} className="flex justify-between gap-4">
              <dt className="text-muted">{action}</dt>
              <dd>
                <Kbd>{keys}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Messages for changes the user didn't just cause: a resting order filling, a stop firing. */
function describeAsync(event: EventView, orders: readonly OrderView[]): string | null {
  const order = (id: string) => orders.find((o) => o.id === id);
  if (event.type === "order.filled") {
    const o = order(event.orderId);
    return o ? `${sideLabel(o.side)} ${qty(o.qty)} ${o.symbol} filled` : "An order filled";
  }
  if (event.type === "stop.triggered") {
    const o = order(event.orderId);
    return `Stop ${o ? `${sideLabel(o.side).toLowerCase()} ${o.symbol} ` : ""}triggered at ₹${price(event.lastPrice)}`;
  }
  return null;
}
