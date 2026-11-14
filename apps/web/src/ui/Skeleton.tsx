/**
 * A still placeholder with the size of the content it stands in for, so the
 * layout does not move when data arrives. Skeletons do not pulse: in this
 * product nothing moves unless the market or the user moved it.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded-sm bg-raised ${className}`} />;
}

/**
 * Reserves exactly the width of `sample` in the current font, for values whose
 * final width is known in advance (a price with a known number of digits).
 */
export function SkeletonText({ sample, className = "" }: { sample: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`num select-none rounded-sm bg-raised text-transparent ${className}`}
    >
      {sample}
    </span>
  );
}
