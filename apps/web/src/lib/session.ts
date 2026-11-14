/**
 * Guest session: one click, no signup. The token lives in localStorage so a
 * refresh keeps the same account; when the market session rolls over the
 * server answers 401 and a new guest is created.
 */

import type { SessionResponse } from "@marketlab/contracts";

import { api } from "./api";

const KEY = "marketlab.session";

function read(): SessionResponse | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as SessionResponse;
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function write(session: SessionResponse | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable (private mode); the session then lasts for this tab.
  }
}

let current: SessionResponse | null = read();
let pending: Promise<SessionResponse> | null = null;

export function storedSession(): SessionResponse | null {
  return current;
}

/** Returns the stored session, or starts a new guest session. Concurrent callers share one request. */
export function ensureSession(): Promise<SessionResponse> {
  if (current) return Promise.resolve(current);
  pending ??= api<SessionResponse>("/api/session", { method: "POST" })
    .then((session) => {
      current = session;
      write(session);
      return session;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function clearSession(): void {
  current = null;
  write(null);
}
