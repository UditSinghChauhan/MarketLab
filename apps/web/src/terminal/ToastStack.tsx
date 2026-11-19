import type { Toast } from "./useOrderToasts";

export function ToastStack({ toasts }: { toasts: readonly Toast[] }) {
  return (
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
  );
}
