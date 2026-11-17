/**
 * Downloads the session log and drives the replay worker.
 *
 * The server sends a head (seed, rules, the sequence and state hash to reach)
 * and then the log in pages. The worker replays it and reports back; this hook
 * turns that into state for the page.
 */

import type { ReplayEntries, ReplayHead } from "@marketlab/contracts";
import type { LogEntry } from "@marketlab/engine";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiRequestError, api } from "../lib/api";
import type { FromWorker, ReplaySnapshot, ToWorker } from "./protocol";

export type ReplayState =
  | { readonly phase: "downloading"; readonly head: ReplayHead | null; readonly received: number }
  | {
      readonly phase: "replaying" | "ready";
      readonly head: ReplayHead;
      readonly snapshot: ReplaySnapshot;
    }
  | { readonly phase: "error"; readonly message: string };

async function download(
  onProgress: (head: ReplayHead, received: number) => void,
): Promise<{ head: ReplayHead; entries: LogEntry[] }> {
  const head = await api<ReplayHead>("/api/replay");
  const entries: LogEntry[] = [];
  onProgress(head, 0);
  while (entries.length < head.seq) {
    const query = new URLSearchParams({
      session: String(head.session),
      after: String(entries.length),
      upto: String(Math.min(head.seq, entries.length + head.pageSize)),
    });
    const page = await api<ReplayEntries>(`/api/replay/entries?${query.toString()}`);
    if (page.entries.length === 0) throw new Error("The server returned an empty page of the log");
    entries.push(...page.entries);
    onProgress(head, entries.length);
  }
  return { head, entries };
}

export function useReplay(symbol: string, enabled: boolean) {
  const [state, setState] = useState<ReplayState>({
    phase: "downloading",
    head: null,
    received: 0,
  });
  const [attempt, setAttempt] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const symbolRef = useRef(symbol);

  const send = useCallback((message: ToWorker) => {
    workerRef.current?.postMessage(message);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const worker = new Worker(new URL("./replay.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    const fail = (message: string) => {
      if (!cancelled) setState({ phase: "error", message });
    };
    worker.onerror = () => {
      fail("The replay worker could not start. Reload the page to try again.");
    };

    download((head, received) => {
      if (!cancelled) setState({ phase: "downloading", head, received });
    })
      .then(({ head, entries }) => {
        if (cancelled) return;
        worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
          if (cancelled) return;
          if (data.type === "error") fail(`The replay stopped: ${data.message}`);
          else {
            setState({
              phase: data.snapshot.done ? "ready" : "replaying",
              head,
              snapshot: data.snapshot,
            });
          }
        };
        const load: ToWorker = {
          type: "load",
          symbol: symbolRef.current,
          log: {
            config: head.config,
            entries,
            head: { seq: head.seq, stateHash: head.stateHash },
          },
        };
        worker.postMessage(load);
      })
      .catch((error: unknown) => {
        fail(
          error instanceof ApiRequestError
            ? error.status === 429
              ? "Too many replays from this address in the last minute. Wait a minute, then try again."
              : `Couldn't download the session log: ${error.message}.`
            : "Couldn't download the session log. Check your connection, then try again.",
        );
      });

    return () => {
      cancelled = true;
      worker.terminate();
      workerRef.current = null;
    };
  }, [enabled, attempt]);

  useEffect(() => {
    symbolRef.current = symbol;
    send({ type: "symbol", symbol });
  }, [symbol, send]);

  const seek = useCallback(
    (position: number) => {
      send({ type: "seek", position });
    },
    [send],
  );
  const retry = useCallback(() => {
    setState({ phase: "downloading", head: null, received: 0 });
    setAttempt((n) => n + 1);
  }, []);

  return { state, seek, retry };
}
