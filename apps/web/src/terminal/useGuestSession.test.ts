// @vitest-environment jsdom
import type { SessionResponse } from "@marketlab/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../lib/api";
import { clearSession, ensureSession, storedSession } from "../lib/session";
import { useGuestSession } from "./useGuestSession";

vi.mock("../lib/session", () => ({
  storedSession: vi.fn(),
  ensureSession: vi.fn(),
  clearSession: vi.fn(),
}));

const guest = (token: string) => ({ token, accountId: "a1" }) as unknown as SessionResponse;

describe("useGuestSession", () => {
  beforeEach(() => {
    vi.mocked(storedSession).mockReturnValue(null);
    vi.mocked(ensureSession).mockResolvedValue(guest("fresh"));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("waits for the exchange to be ready before opening a guest account", async () => {
    const { result, rerender } = renderHook(({ ready }) => useGuestSession(ready), {
      initialProps: { ready: false },
    });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(result.current.token).toBeNull();

    rerender({ ready: true });
    await waitFor(() => {
      expect(result.current.token).toBe("fresh");
    });
    expect(ensureSession).toHaveBeenCalledOnce();
  });

  it("reuses a stored session without asking for a new one", () => {
    vi.mocked(storedSession).mockReturnValue(guest("stored"));
    const { result } = renderHook(() => useGuestSession(true));
    expect(result.current.token).toBe("stored");
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("shows the server's explanation, or a plain one when it is unreachable, and can try again", async () => {
    vi.mocked(ensureSession).mockRejectedValueOnce(
      new ApiRequestError(429, "rate_limited", "Too many requests; try again in 1 minute", null),
    );
    const limited = renderHook(() => useGuestSession(true));
    await waitFor(() => {
      expect(limited.result.current.sessionError).toBe("Too many requests; try again in 1 minute");
    });
    act(() => {
      limited.result.current.startSession();
    });
    await waitFor(() => {
      expect(limited.result.current.token).toBe("fresh");
    });
    expect(limited.result.current.sessionError).toBeNull();
    cleanup();

    vi.mocked(ensureSession).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offline = renderHook(() => useGuestSession(true));
    await waitFor(() => {
      expect(offline.result.current.sessionError).toBe("The exchange isn't reachable right now.");
    });
  });

  it("replaces a session the server no longer accepts", async () => {
    vi.mocked(storedSession).mockReturnValue(guest("expired"));
    const { result } = renderHook(() => useGuestSession(true));
    expect(result.current.token).toBe("expired");

    act(() => {
      result.current.renewSession();
    });
    expect(clearSession).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(result.current.token).toBe("fresh");
    });
  });
});
