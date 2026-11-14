/** Positions and orders for the guest account. */

import type { AccountView, OrderView } from "@marketlab/contracts";
import { useId, useState } from "react";

import { direction, price, qty, rupees, signedRupees, time } from "../lib/format";
import { cancelMessage, sideLabel, statusLabel, typeLabel } from "../lib/orders";
import { Skeleton } from "../ui/Skeleton";

type Tab = "positions" | "orders";

const tone = (value: string) =>
  direction(value) === "up" ? "text-bid" : direction(value) === "down" ? "text-ask" : "text-muted";

export function Blotter({
  account,
  orders,
  onCancel,
  onInspect,
  cancelling,
  ordersLoading = false,
}: {
  account: AccountView | null;
  orders: readonly OrderView[];
  /** True until the first order list has loaded. */
  ordersLoading?: boolean;
  onCancel: (id: string) => void;
  onInspect: (id: string) => void;
  cancelling: ReadonlySet<string>;
}) {
  const [tab, setTab] = useState<Tab>("positions");
  const id = useId();
  const open = orders.filter((o) => o.status === "resting" || o.status === "pending_stop").length;

  return (
    <section aria-label="Account" className="flex min-h-0 flex-1 flex-col bg-surface">
      <div
        role="tablist"
        aria-label="Account views"
        className="flex h-9 shrink-0 items-center gap-4 border-b border-line px-3"
      >
        {(
          [
            [
              "positions",
              `Positions ${String(account?.positions.filter((p) => p.qty > 0).length ?? 0)}`,
            ],
            ["orders", `Orders${open > 0 ? ` (${String(open)} open)` : ""}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            id={`${id}-${value}`}
            aria-controls={`${id}-panel`}
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
            }}
            className={`-mb-px h-9 border-b-2 text-xs font-medium ${
              tab === value
                ? "border-accent text-text"
                : "border-transparent text-muted hover:text-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto"
      >
        {tab === "positions" ? (
          account ? (
            <Positions account={account} />
          ) : (
            <RowsSkeleton label="Loading your positions" />
          )
        ) : ordersLoading ? (
          <RowsSkeleton label="Loading your orders" />
        ) : (
          <Orders
            orders={orders}
            onCancel={onCancel}
            onInspect={onInspect}
            cancelling={cancelling}
          />
        )}
      </div>
    </section>
  );
}

/** Placeholder rows with the height of the tables' header and rows. */
function RowsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <div className="h-7" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-8 items-center gap-6 border-t border-line px-3">
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="ml-auto h-2.5 w-16" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function Positions({ account }: { account: AccountView }) {
  const rows = account.positions;
  if (rows.length === 0) {
    return (
      <p className="p-4 text-sm text-muted">
        You don't hold anything yet. Buy from the ticket, or click a price in the book to start a
        limit order.
      </p>
    );
  }
  return (
    <table className="w-full min-w-[640px] text-sm">
      <thead className="sticky top-0 bg-surface text-2xs text-muted">
        <tr className="h-7 [&>th]:px-3 [&>th]:font-normal">
          <th scope="col" className="text-left">
            Symbol
          </th>
          <th scope="col" className="text-right">
            Shares
          </th>
          <th scope="col" className="text-right">
            Avg price
          </th>
          <th scope="col" className="text-right">
            Last
          </th>
          <th scope="col" className="text-right">
            Market value
          </th>
          <th scope="col" className="text-right">
            Unrealised
          </th>
          <th scope="col" className="text-right">
            Realised
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.symbol} className="h-8 border-t border-line [&>td]:px-3">
            <td className="font-medium">{p.symbol}</td>
            <td className="num text-right">
              {qty(p.qty)}
              {p.reserved > 0 && (
                <span className="ml-1 text-xs text-muted">({qty(p.reserved)} on order)</span>
              )}
            </td>
            <td className="num text-right">{price(p.avgPrice)}</td>
            <td className="num text-right">{price(p.last)}</td>
            <td className="num text-right">{rupees(p.marketValue)}</td>
            <td className={`num text-right ${tone(p.unrealizedPnl)}`}>
              {signedRupees(p.unrealizedPnl)}
            </td>
            <td className={`num text-right ${tone(p.realizedPnl)}`}>
              {signedRupees(p.realizedPnl)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Orders({
  orders,
  onCancel,
  onInspect,
  cancelling,
}: {
  orders: readonly OrderView[];
  onCancel: (id: string) => void;
  onInspect: (id: string) => void;
  cancelling: ReadonlySet<string>;
}) {
  if (orders.length === 0) {
    return <p className="p-4 text-sm text-muted">Orders you place appear here, newest first.</p>;
  }
  return (
    <table className="w-full min-w-[720px] text-sm">
      <thead className="sticky top-0 bg-surface text-2xs text-muted">
        <tr className="h-7 [&>th]:px-3 [&>th]:font-normal">
          <th scope="col" className="text-left">
            Time
          </th>
          <th scope="col" className="text-left">
            Order
          </th>
          <th scope="col" className="text-right">
            Price
          </th>
          <th scope="col" className="text-right">
            Filled
          </th>
          <th scope="col" className="text-right">
            Avg fill
          </th>
          <th scope="col" className="text-left">
            Status
          </th>
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const open = o.status === "resting" || o.status === "pending_stop";
          return (
            <tr key={o.id} className="h-8 border-t border-line [&>td]:px-3">
              <td className="num text-muted">{time(o.createdAt)}</td>
              <td>
                <span className={o.side === "buy" ? "text-bid" : "text-ask"}>
                  {sideLabel(o.side)}
                </span>{" "}
                {qty(o.qty)} {o.symbol}{" "}
                <span className="text-muted">{typeLabel(o.type).toLowerCase()}</span>
              </td>
              <td className="num text-right">
                {o.price ? price(o.price) : o.stopPrice ? `stop ${price(o.stopPrice)}` : "market"}
              </td>
              <td className="num text-right">
                {qty(o.filled)}/{qty(o.qty)}
              </td>
              <td className="num text-right">{price(o.avgFillPrice)}</td>
              <td
                title={o.reason ? cancelMessage(o.reason) : undefined}
                className={open ? "text-pending" : "text-muted"}
              >
                {statusLabel(o)}
              </td>
              <td className="whitespace-nowrap text-right">
                <button
                  type="button"
                  onClick={() => {
                    onInspect(o.id);
                  }}
                  className="mr-3 text-xs text-accent hover:underline"
                >
                  Trace
                </button>
                {open && (
                  <button
                    type="button"
                    disabled={cancelling.has(o.id)}
                    onClick={() => {
                      onCancel(o.id);
                    }}
                    className="text-xs text-muted hover:text-ask disabled:opacity-50"
                  >
                    {cancelling.has(o.id) ? "Cancelling" : "Cancel"}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
