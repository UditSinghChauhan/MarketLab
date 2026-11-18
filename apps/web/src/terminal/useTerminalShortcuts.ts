import { useEffect, useEffectEvent } from "react";

import { isField } from "./OrderTicket";

/**
 * The terminal's own keys: `I` opens or closes the engine inspector and `?`
 * lists every shortcut. The order ticket handles its keys itself. Nothing
 * fires while typing in a field or with a modifier held.
 */
export function useTerminalShortcuts(handlers: {
  onToggleInspector: () => void;
  onShowShortcuts: () => void;
}) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isField(event.target)) return;
    if (event.key === "i" || event.key === "I") {
      event.preventDefault();
      handlers.onToggleInspector();
    }
    if (event.key === "?") handlers.onShowShortcuts();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      onKey(event);
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, []);
}
