/**
 * The engine inspector: one order's path through the system, step by step,
 * with the time each step took and every engine event it produced.
 */

import type { OrderTrace, OrderView } from "@marketlab/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { duration, time } from "../lib/format";
import { describeEvent, sideLabel, typeLabel } from "../lib/orders";
import { Kbd } from "../ui/Panel";

export function Inspector({
  open,
  onClose,
  orders,
  selectedId,
  onSelect,
  token,
  version,
}: {
  open: boolean;
  onClose: () => void;
  orders: readonly OrderView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  token: string | null;
  /** Changes whenever the user's orders change, so the trace refreshes on later fills. */
  version: number;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const orderId = selectedId ?? orders[0]?.id ?? null;
  const trace = useQuery({
    queryKey: ["trace", orderId, version],
    queryFn: () => api<OrderTrace>(`/api/orders/${orderId ?? ""}/trace`, { token }),
    enabled: open && orderId !== null && token !== null,
    placeholderData: (previous) => (previous?.orderId === orderId ? previous : undefined),
  });

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <aside
      aria-label="Engine inspector"
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.6)]"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div>
          <h2 className="text-sm font-semibold">Engine inspector</h2>
          <p className="text-xs text-muted">What happened to your order, step by step</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-text"
        >
          Close <Kbd>I</Kbd>
        </button>
      </header>

      {orders.length === 0 ? (
        <div className="p-5 text-sm leading-relaxed text-muted">
          Place an order and it will appear here: when the API received it, how long it waited, how
          long the write to the command log took, how many microseconds the matching engine spent on
          it, and every event it caused.
        </div>
      ) : (
        <>
          <label className="block border-b border-line px-4 py-3">
            <span className="mb-1 block text-xs text-muted">Order</span>
            <select
              value={orderId ?? ""}
              onChange={(e) => {
                onSelect(e.target.value);
              }}
              className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm"
            >
              {orders.slice(0, 30).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id}: {sideLabel(o.side)} {o.qty} {o.symbol} {typeLabel(o.type).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {trace.isError && <p className="text-sm text-ask">Couldn't load this order's trace.</p>}
            {trace.data && <TraceView trace={trace.data} />}
          </div>
        </>
      )}
    </aside>
  );
}

function TraceView({ trace }: { trace: OrderTrace }) {
  const [raw, setRaw] = useState(false);
  const t = trace.timing;
  const persistUs = t ? t.persistMs * 1000 : 0;

  return (
    <div className="space-y-6">
      {t && (
        <section aria-label="Request timing">
          <h3 className="mb-3 text-xs font-medium text-muted">Request path</h3>
          <ol className="space-y-3">
            {[
              [
                "Received by the API",
                time(t.receivedAt),
                "The request was authenticated and validated.",
              ],
              [
                "Waited for its turn",
                duration(t.queueMs * 1000),
                "One writer applies commands in order, so none can interleave.",
              ],
              [
                "Written to the command log",
                duration(persistUs),
                "Stored in Postgres before the engine touched it.",
              ],
              [
                "Matched by the engine",
                duration(t.engineUs),
                "In memory: price-time priority, reservations, settlement.",
              ],
            ].map(([title, value, detail], i) => (
              <li key={title} className="grid grid-cols-[1.25rem_1fr_auto] gap-x-3">
                <span className="num pt-px text-xs text-muted">{i + 1}</span>
                <span className="text-sm">{title}</span>
                <span className="num text-sm font-medium">{value}</span>
                <span />
                <span className="col-span-2 text-xs text-muted">{detail}</span>
              </li>
            ))}
          </ol>
          {persistUs > 0 && t.engineUs > 0 && (
            <p className="mt-4 rounded-md bg-raised px-3 py-2 text-xs leading-relaxed text-muted">
              Matching took {duration(t.engineUs)}; the durable write took {duration(persistUs)}.
              The engine is about{" "}
              <span className="text-text">
                {Math.max(1, Math.round(persistUs / t.engineUs)).toLocaleString("en-IN")}×
              </span>{" "}
              faster than the disk, which is why the log, not the engine, sets the latency.
            </p>
          )}
        </section>
      )}

      <section aria-label="Engine events">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-medium text-muted">Engine events</h3>
          <button
            type="button"
            onClick={() => {
              setRaw((r) => !r);
            }}
            aria-pressed={raw}
            className="text-xs text-accent hover:underline"
          >
            {raw ? "Show summary" : "Show raw events"}
          </button>
        </div>
        {raw ? (
          <pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-2xs leading-relaxed text-muted">
            {JSON.stringify(trace.events, null, 2)}
          </pre>
        ) : (
          <ol className="relative space-y-4 border-l border-line pl-4">
            {trace.events.map((event) => {
              const { title, detail } = describeEvent(event, trace.orderId);
              const tone =
                event.type === "trade" || event.type === "order.filled"
                  ? "bg-bid"
                  : event.type === "order.cancelled" || event.type === "order.rejected"
                    ? "bg-ask"
                    : event.type === "order.rested" || event.type === "stop.triggered"
                      ? "bg-pending"
                      : "bg-accent";
              return (
                <li key={`${String(event.seq)}-${event.type}`} className="relative">
                  <span
                    aria-hidden="true"
                    className={`absolute -left-[1.3rem] top-1.5 size-2 rounded-full ${tone}`}
                  />
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">{title}</span>
                    <span className="num text-2xs text-muted">
                      #{event.seq} {time(event.at)}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted">{detail}</p>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
