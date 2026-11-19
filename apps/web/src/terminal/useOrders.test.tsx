// @vitest-environment jsdom
import type { OrderView } from "@marketlab/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, api } from "../lib/api";
import { useOrders } from "./useOrders";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: vi.fn(),
}));

const order = { id: "o1", symbol: "ORBT" } as OrderView;

function setup(token: string | null, renewSession = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(({ version }) => useOrders(token, version, renewSession), {
    wrapper,
    initialProps: { version: 0 },
  });
  return { ...hook, renewSession };
}

describe("useOrders", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("asks for nothing before there is a session", () => {
    const { result } = setup(null);
    expect(api).not.toHaveBeenCalled();
    expect(result.current.list).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it("loads the guest's orders and refetches when the stream reports a change", async () => {
    vi.mocked(api).mockResolvedValue([order]);
    const { result, rerender } = setup("tok");
    await waitFor(() => {
      expect(result.current.list).toEqual([order]);
    });
    expect(result.current.loading).toBe(false);
    expect(api).toHaveBeenCalledWith("/api/orders", { token: "tok" });

    rerender({ version: 1 });
    await waitFor(() => {
      expect(api).toHaveBeenCalledTimes(2);
    });
  });

  it("renews the session when the server no longer accepts it", async () => {
    vi.mocked(api).mockRejectedValue(new ApiRequestError(401, "session_expired", "Ended", null));
    const { renewSession } = setup("tok");
    await waitFor(() => {
      expect(renewSession).toHaveBeenCalledOnce();
    });
  });

  it("keeps the session on other errors", async () => {
    vi.mocked(api).mockRejectedValue(new ApiRequestError(500, "internal", "Oops", null));
    const { result, renewSession } = setup("tok");
    // An errored query is no longer pending: wait for it to settle, then check.
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(api).toHaveBeenCalledOnce();
    expect(result.current.list).toEqual([]);
    expect(renewSession).not.toHaveBeenCalled();
  });
});
