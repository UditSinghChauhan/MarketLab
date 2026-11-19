import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/Panel";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
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
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="mt-4 space-y-2 text-sm">
        {rows.map(([keys, action]) => (
          <div key={keys} className="flex justify-between gap-4">
            <dt className="text-muted">{action}</dt>
            <dd>
              <Kbd>{keys}</Kbd>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center gap-2 rounded-md border border-line px-3 text-xs font-medium hover:bg-raised"
        >
          Close <Kbd>Esc</Kbd>
        </button>
      </div>
    </Dialog>
  );
}

export function StartOverDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog title="Start over with a new account?" onClose={onCancel}>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        You get a fresh guest account with ₹10,00,000. This account's positions and open orders stay
        on the exchange, but you won't be able to return to them.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          data-autofocus
          onClick={onCancel}
          className="h-9 rounded-md border border-line px-3 text-sm font-medium hover:bg-raised"
        >
          Keep this account
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="h-9 rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink hover:opacity-90"
        >
          Start over
        </button>
      </div>
    </Dialog>
  );
}
