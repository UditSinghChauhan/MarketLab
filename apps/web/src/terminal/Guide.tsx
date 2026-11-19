/**
 * First-run guide: three things worth trying, in one quiet row under the
 * header. Each step ticks itself off when the visitor does it. Dismissed (or
 * completed) once, it never comes back on this browser.
 */

import { useCallback, useEffect, useState } from "react";

import { useTouch } from "../lib/useTouch";
import { Kbd } from "../ui/Panel";

export type GuideStep = "order" | "price" | "inspector";

const KEY = "marketlab.guide";
const STEPS: readonly GuideStep[] = ["order", "price", "inspector"];

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    return false; // storage unavailable (private mode): show the guide for this visit
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    // Nothing to do: the guide stays dismissed for this visit only.
  }
}

interface GuideState {
  readonly visible: boolean;
  readonly done: ReadonlySet<GuideStep>;
}

export function useGuide() {
  const [state, setState] = useState<GuideState>(() => ({
    visible: !wasDismissed(),
    done: new Set(),
  }));

  useEffect(() => {
    if (!state.visible) rememberDismissed();
  }, [state.visible]);

  const complete = useCallback((step: GuideStep) => {
    setState((s) => {
      if (!s.visible || s.done.has(step)) return s;
      const done = new Set(s.done).add(step);
      return { done, visible: done.size < STEPS.length };
    });
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => ({ ...s, visible: false }));
  }, []);

  return { ...state, complete, dismiss };
}

export function Guide({
  done,
  onDismiss,
}: {
  done: ReadonlySet<GuideStep>;
  onDismiss: () => void;
}) {
  const touch = useTouch();
  const step = (id: GuideStep, number: number, children: React.ReactNode) => {
    const complete = done.has(id);
    return (
      <li className={`flex items-center gap-2 ${complete ? "text-muted" : "text-text"}`}>
        <span
          className={`num grid size-[1.125rem] shrink-0 place-items-center rounded-full border text-2xs leading-none ${
            complete ? "border-bid text-bid" : "border-faint text-muted"
          }`}
        >
          {complete ? (
            <svg viewBox="0 0 12 12" className="size-2.5" role="img" aria-label="Done">
              <path
                d="M2.5 6.5l2.5 2.5 4.5-5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          ) : (
            number
          )}
        </span>
        <span>{children}</span>
      </li>
    );
  };

  return (
    <section
      aria-label="Getting started"
      className="grid shrink-0 grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 border-b border-line bg-raised px-3 py-2 text-xs lg:grid-cols-[auto_1fr_auto]"
    >
      <h2 className="font-medium text-muted">New here? Three things to try</h2>
      <ol className="col-span-2 row-start-2 flex flex-col gap-x-6 gap-y-1.5 sm:flex-row sm:flex-wrap sm:items-center lg:col-span-1 lg:col-start-2 lg:row-start-1">
        {step("order", 1, "Place an order from the ticket")}
        {step("price", 2, `${touch ? "Tap" : "Click"} a price in the order book`)}
        {step(
          "inspector",
          3,
          touch ? (
            "Open the inspector to trace your order"
          ) : (
            <>
              Open the inspector <Kbd>I</Kbd> to trace your order
            </>
          ),
        )}
      </ol>
      <button
        type="button"
        onClick={onDismiss}
        className="-my-1 rounded px-2 py-1 font-medium text-muted hover:bg-surface hover:text-text"
      >
        Dismiss
      </button>
    </section>
  );
}
