import { Component, type ErrorInfo, type ReactNode } from "react";

import { Logo } from "./Logo";

interface Props {
  /** Changes when the route changes, which clears a previous error. */
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
  readonly resetKey: string;
}

/** Catches a crash in any page and offers a way out instead of a blank screen. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("MarketLab page crashed:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-6 text-text">
        <div className="max-w-sm text-center">
          <Logo className="text-lg" />
          <h1 className="mt-8 text-xl font-semibold">Something broke on this page</h1>
          <p className="mt-2 text-muted">
            The exchange is still running and your account is safe. Reloading usually fixes it.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                window.location.reload();
              }}
              className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Reload
            </button>
            {/* A full navigation, so a broken client-side state cannot follow the visitor. */}
            <a
              href="/terminal"
              className="inline-flex h-10 items-center rounded-md border border-line bg-surface px-4 text-sm font-medium hover:border-muted"
            >
              Back to the market
            </a>
          </div>
        </div>
      </main>
    );
  }
}
