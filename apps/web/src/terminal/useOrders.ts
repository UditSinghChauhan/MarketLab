import type { OrderView } from "@marketlab/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { ApiRequestError, api } from "../lib/api";

/**
 * The guest's orders. They are refetched whenever the stream reports a change
 * (`ordersVersion`), and a 401 means the session is gone, so it is renewed.
 */
export function useOrders(token: string | null, ordersVersion: number, renewSession: () => void) {
  const queryClient = useQueryClient();
  const orders = useQuery({
    queryKey: ["orders", token],
    queryFn: async () => {
      try {
        return await api<OrderView[]>("/api/orders", { token });
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) renewSession();
        throw error;
      }
    },
    enabled: token !== null,
  });
  const list = useMemo(() => orders.data ?? [], [orders.data]);

  useEffect(() => {
    if (ordersVersion > 0) void queryClient.invalidateQueries({ queryKey: ["orders"] });
  }, [ordersVersion, queryClient]);

  return { list, loading: orders.isPending };
}
