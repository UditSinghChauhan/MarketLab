import { useMemo, useRef } from "react";

import { newClientOrderId } from "./orders";

/**
 * Client order ids for one order form: a new id for each new order, and the
 * same id again when the user resends an order whose outcome is unknown with
 * unchanged details, so the exchange answers with the first attempt instead
 * of placing it twice.
 */
export function useClientOrderId() {
  const unresolved = useRef<{ key: string; id: string } | null>(null);
  return useMemo(
    () => ({
      /** The id to send; `details` identifies the order (its request body). */
      next(details: unknown): string {
        const key = JSON.stringify(details);
        const id = unresolved.current?.key === key ? unresolved.current.id : newClientOrderId();
        unresolved.current = { key, id };
        return id;
      },
      /** The exchange answered, or certainly refused: the next order is a new one. */
      settled(): void {
        unresolved.current = null;
      },
    }),
    [],
  );
}
