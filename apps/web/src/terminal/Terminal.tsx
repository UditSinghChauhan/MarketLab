import type { CommandResult } from "@marketlab/contracts";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router";

import { ApiRequestError, api } from "../lib/api";
import { useExchange } from "../lib/health";
import { useMarketStream } from "../lib/stream";
import { useTouch } from "../lib/useTouch";
import { Panel } from "../ui/Panel";
import { useAfterFirstPaint } from "../ui/useAfterFirstPaint";
import { Blotter } from "./Blotter";
import { ChartPanel } from "./ChartPanel";
import { Guide, stepsDoneBy, useGuide } from "./Guide";
import { Inspector } from "./Inspector";
import { MarketStrip } from "./MarketStrip";
import { SYMBOLS } from "./markets";
import { OrderBookLadder } from "./OrderBookLadder";
import { OrderTicket, type Prefill } from "./OrderTicket";
import { ShortcutsDialog, StartOverDialog } from "./TerminalDialogs";
import { TerminalHeader } from "./TerminalHeader";
import { ToastStack } from "./ToastStack";
import { TradeTape } from "./TradeTape";
import { useGuestSession } from "./useGuestSession";
import { useOrders } from "./useOrders";
import { useOrderToasts } from "./useOrderToasts";
import { useTerminalShortcuts } from "./useTerminalShortcuts";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: false } },
});

export function TerminalRoute() {
  const { symbol = "ORBT" } = useParams();
  const upper = symbol.toUpperCase();
  if (!(SYMBOLS as readonly string[]).includes(upper))
    return <Navigate to="/terminal/ORBT" replace />;
  return (
    <QueryClientProvider client={queryClient}>
      <Terminal symbol={upper} />
    </QueryClientProvider>
  );
}

function Terminal({ symbol }: { symbol: string }) {
  const queryClient = useQueryClient();
  const exchange = useExchange();
  const touch = useTouch();
  // The first frame already shows prices (sent with the page); the session and
  // the stream start right after it, so they never hold back that paint.
  const painted = useAfterFirstPaint();
  const ready = exchange.state === "ready" && painted;
  const { token, sessionError, startSession, renewSession } = useGuestSession(ready);

  // The browser tab and its toolbar follow the page: graphite here, light on the landing page.
  useEffect(() => {
    const previousTitle = document.title;
    const theme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousTheme = theme?.content;
    document.title = `${symbol} on MarketLab`;
    if (theme) theme.content = "#171E27";
    return () => {
      document.title = previousTitle;
      if (theme && previousTheme !== undefined) theme.content = previousTheme;
    };
  }, [symbol]);

  const market = useMarketStream(symbol, token, { onSessionEnded: renewSession, enabled: ready });
  const summary = market.markets.find((m) => m.symbol === symbol);

  const orders = useOrders(token, market.ordersVersion, renewSession);
  const orderList = orders.list;
  const { toasts, toast, markOwn } = useOrderToasts(market.lastOrderEvents, orderList);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspected, setInspected] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const guide = useGuide();
  const completeStep = guide.complete;

  useEffect(() => {
    if (inspectorOpen) completeStep("inspector");
  }, [inspectorOpen, completeStep]);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());

  const toggleInspector = () => {
    setInspectorOpen((o) => !o);
  };
  const showShortcuts = () => {
    setShortcutsOpen(true);
  };
  useTerminalShortcuts({ onToggleInspector: toggleInspector, onShowShortcuts: showShortcuts });

  const onResult = (result: CommandResult) => {
    markOwn(result.events);
    if (result.orderId) setInspected(result.orderId);
    for (const step of stepsDoneBy(result, prefill)) completeStep(step);
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
  };

  const startOver = () => {
    setConfirmStartOver(false);
    setInspectorOpen(false);
    setInspected(null);
    queryClient.removeQueries({ queryKey: ["orders"] });
    queryClient.removeQueries({ queryKey: ["trace"] });
    renewSession(); // clears the stored guest; a new one is opened once it is gone
    toast("Started a new account with ₹10,00,000", "info");
  };

  const cancel = async (id: string) => {
    setCancelling((s) => new Set(s).add(id));
    try {
      const result = await api<CommandResult>(`/api/orders/${id}`, { method: "DELETE", token });
      markOwn(result.events);
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

  return (
    <div className="dark-ui flex min-h-dvh flex-col bg-bg text-text xl:h-dvh">
      <TerminalHeader
        symbol={symbol}
        markets={market.markets}
        status={market.status}
        exchange={exchange.state}
        account={account}
        inspectorOpen={inspectorOpen}
        onToggleInspector={toggleInspector}
        onShowShortcuts={showShortcuts}
        onStartOver={() => {
          setConfirmStartOver(true);
        }}
      />

      <MarketStrip markets={market.markets} />

      {guide.visible && <Guide done={guide.done} onDismiss={guide.dismiss} />}

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
        <ChartPanel
          symbol={symbol}
          summary={summary}
          candles={market.candles}
          candlesLoaded={market.candlesLoaded}
          exchange={exchange}
        />

        <Panel
          title="Order book"
          aside={
            <span className="text-2xs text-muted">{touch ? "Tap" : "Click"} a price to use it</span>
          }
          className="order-3 md:row-span-2 xl:order-none"
        >
          <OrderBookLadder
            book={market.book}
            myPrices={myPrices}
            onPick={(p, side) => {
              setPrefill({ price: p, side, nonce: Date.now() });
            }}
          />
        </Panel>

        {/* At xl the panel has a fixed height: a size container, so the ticket can tell
            whether it has room for its optional holding line. */}
        <Panel
          title="Place an order"
          className="order-2 xl:order-none"
          bodyClassName="overflow-y-auto xl:[container-type:size]"
        >
          <OrderTicket
            key={symbol}
            market={summary}
            account={account}
            token={token}
            prefill={prefill}
            onResult={onResult}
          />
        </Panel>

        {/* min-w-0: the positions table scrolls inside its panel, never widening the page. */}
        <div className="order-5 flex h-[320px] min-w-0 md:col-span-2 xl:order-none xl:col-span-1 xl:col-start-1 xl:row-start-2 xl:h-auto">
          <Blotter
            account={account}
            orders={orderList}
            ordersLoading={orders.loading}
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
          scrollable
        >
          <TradeTape trades={market.trades} loading={!market.tradesLoaded} />
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
        <ShortcutsDialog
          onClose={() => {
            setShortcutsOpen(false);
          }}
        />
      )}

      {confirmStartOver && (
        <StartOverDialog
          onCancel={() => {
            setConfirmStartOver(false);
          }}
          onConfirm={startOver}
        />
      )}

      <ToastStack toasts={toasts} />
    </div>
  );
}
