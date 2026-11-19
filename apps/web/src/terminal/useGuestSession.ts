import { useCallback, useEffect, useState } from "react";

import { ApiRequestError } from "../lib/api";
import { clearSession, ensureSession, storedSession } from "../lib/session";

/**
 * The visitor's guest account. One is opened once the server is awake, not
 * while it is still starting. `renewSession` drops a session the server no
 * longer accepts, and a fresh one is opened in its place.
 */
export function useGuestSession(ready: boolean) {
  const [session, setSession] = useState(storedSession);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const startSession = useCallback(() => {
    ensureSession()
      .then((s) => {
        setSession(s);
        setSessionError(null);
      })
      .catch((error: unknown) => {
        setSessionError(
          error instanceof ApiRequestError
            ? error.message
            : "The exchange isn't reachable right now.",
        );
      });
  }, []);

  useEffect(() => {
    if (!session && ready) startSession();
  }, [session, ready, startSession]);

  const renewSession = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  return { token: session?.token ?? null, sessionError, startSession, renewSession };
}
