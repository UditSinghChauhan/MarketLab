/** Messages between the replay page and its Web Worker. */

import type { ReplayFrame, ReplayLog, Verdict } from "@marketlab/engine";

export type ToWorker =
  /** Start replaying a downloaded log, showing `symbol`. */
  | { readonly type: "load"; readonly log: ReplayLog; readonly symbol: string }
  /** Move to a position (in steps). Ignored until the first pass has finished. */
  | { readonly type: "seek"; readonly position: number }
  | { readonly type: "symbol"; readonly symbol: string };

export interface ReplaySnapshot {
  /** True once the whole log has been replayed and judged; scrubbing works from then on. */
  readonly done: boolean;
  readonly totalSteps: number;
  /** Log entries fully applied at the current position. */
  readonly seq: number;
  readonly verdict: Verdict;
  /** Milliseconds the first pass has taken (so far, or in total once done). */
  readonly elapsedMs: number;
  /** Engine commands in the whole session; known once the first pass is done. */
  readonly totalCommands: number;
  /** Session time at the first and the last position. */
  readonly startTime: number;
  readonly endTime: number;
  /** The market at the current position. */
  readonly frame: ReplayFrame;
}

export type FromWorker =
  | { readonly type: "snapshot"; readonly snapshot: ReplaySnapshot }
  | { readonly type: "error"; readonly message: string };
