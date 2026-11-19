/**
 * The engine inspector: one order's path through the system, step by step,
 * with the time each step took and every engine event it produced.
 */

import type { CommandTiming, EngineStats, OrderTrace, OrderView } from "@marketlab/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { api } from "../lib/api";
import { duration, time } from "../lib/format";
import { useExchange } from "../lib/health";
import { describeEvent, sideLabel, typeLabel } from "../lib/orders";
import { useFocusScope } from "../ui/Dialog";
import { Kbd } from "../ui/Panel";
import { Skeleton } from "../ui/Skeleton";

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
  const panelRef = useRef<HTMLElement>(null);
  const orderId = selectedId ?? orders[0]?.id ?? null;
  const trace = useQuery({
    queryKey: ["trace", orderId, version],
    queryFn: () => api<OrderTrace>(`/api/orders/${orderId ?? ""}/trace`, { token }),
    enabled: open && orderId !== null && token !== null,
    placeholderData: (previous) => (previous?.orderId === orderId ? previous : undefined),
  });

  // Focus moves into the panel, Tab stays inside it, and closing returns focus
  // to the control that opened it. The page behind stays usable with a pointer.
  useFocusScope(panelRef, open);

  if (!open) return null;

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-label="Engine inspector"
      tabIndex={-1}
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.6)]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation(); // close the panel, don't also clear the order ticket
          onClose();
        }
      }}
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div>
          <h2 className="text-sm font-semibold">Engine inspector</h2>
          <p className="text-xs text-muted">What happened to your order, step by step</p>
        </div>
        <button
          type="button"
          data-autofocus
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
          <div
            tabIndex={0}
            role="region"
            aria-label="Order trace"
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          >
            {trace.isError && (
              <p className="text-sm text-ask">
                Couldn't load this order's trace. Close the inspector and open it again to retry.
              </p>
            )}
            {trace.data ? <TraceView trace={trace.data} /> : trace.isPending && <TraceSkeleton />}
          </div>
        </>
      )}
    </section>
  );
}

function TraceSkeleton() {
  return (
    <div role="status" aria-label="Loading the trace" className="space-y-3">
      <Skeleton className="h-3 w-24" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

/** The step that took longest for this order, in the words of the request path above. */
export function slowestStep(timing: CommandTiming): { step: string; us: number } {
  const steps = [
    { step: "Waiting for its turn", us: timing.queueMs * 1000 },
    { step: "The write to the command log", us: timing.persistMs * 1000 },
    { step: "Matching", us: timing.engineUs },
  ];
  return steps.reduce((slowest, s) => (s.us > slowest.us ? s : slowest));
}

/** Fewer visitor orders than this since the server started, and their median is not shown. */
export const MIN_VISITOR_SAMPLES = 5;

/**
 * This order's engine time beside the medians it should be compared with, and
 * which step set its latency. Visitor orders and bot commands are reported
 * apart: a visitor's order runs right after its log write, with cold caches,
 * while bot commands are mostly quotes that never match, run back to back.
 * Every clause stays true for an unusually slow or fast order.
 */
export function LatencySummary({
  timing,
  engine,
}: {
  timing: CommandTiming;
  /** The engine's rolling medians from /api/health; undefined until health has loaded. */
  engine: Pick<EngineStats, "bots" | "visitors"> | undefined;
}) {
  const slowest = slowestStep(timing);
  const visitors =
    engine && engine.visitors.samples >= MIN_VISITOR_SAMPLES ? engine.visitors : undefined;
  return (
    <p className="mt-4 rounded-md bg-raised px-3 py-2 text-xs leading-relaxed text-muted">
      Matching this order took <span className="num text-text">{duration(timing.engineUs)}</span>.
      {visitors && (
        <>
          {" "}
          Visitors' orders since the server started take a median of{" "}
          <span className="num text-text">{duration(visitors.p50Us)}</span> (
          {visitors.samples.toLocaleString("en-IN")} orders);
        </>
      )}
      {engine && (
        <>
          {" "}
          {visitors ? "the" : "The"} simulated traders' commands, mostly quotes that never trade,
          take {visitors ? "" : "a median of "}
          <span className="num text-text">{duration(engine.bots.p50Us)}</span>.
        </>
      )}{" "}
      {slowest.step} was the slowest step (
      <span className="num text-text">{duration(slowest.us)}</span>), so it set this order's
      latency.
    </p>
  );
}

function TraceView({ trace }: { trace: OrderTrace }) {
  const [raw, setRaw] = useState(false);
  const engine = useExchange().health?.engine;
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
          <LatencySummary timing={t} engine={engine} />
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
