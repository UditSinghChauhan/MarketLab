import { useEffect, useId, type ReactNode, type RefObject, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for a layer that opens over the page: focus moves into it,
 * Tab cycles inside it, and when it closes focus returns to whatever opened it.
 */
export function useFocusScope(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    (node.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0] ?? node).focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const all = items();
      const first = all[0];
      const last = all.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const outside = !node.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, ref]);
}

/** A modal dialog: dims the page, traps focus, closes on Escape or a click outside. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusScope(ref, true);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-5 shadow-[0_24px_48px_-16px_rgb(0_0_0/0.6)]"
        onKeyDown={(event) => {
          // Keys typed in a dialog belong to the dialog, not to the page's shortcuts.
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
      >
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
