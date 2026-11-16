import { useElapsedSeconds } from "../lib/health";

/** Shown while the free server wakes up. Goes away on its own when the exchange answers. */
export function StartingNotice({
  since,
  className = "",
}: {
  since: number | null;
  className?: string;
}) {
  const seconds = useElapsedSeconds(since);
  return (
    <div className={`max-w-[34ch] text-center ${className}`}>
      <div role="status">
        <p className="text-sm font-semibold text-text">Starting the exchange</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          The free server sleeps when idle and is waking up, which takes up to about a minute. This
          page goes live on its own.
        </p>
      </div>
      {/* Outside the live region, so a screen reader is not interrupted every second. */}
      <p aria-hidden="true" className="num mt-3 text-xs text-muted">
        {seconds} s so far
      </p>
    </div>
  );
}
