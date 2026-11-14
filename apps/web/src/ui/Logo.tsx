/** The mark is a depth chart: bids stepping down to the spread, asks stepping up from it. */
export function LogoMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M2 6h2v14H2zM5 10h2v10H5zM8 14h2v6H8z" fill="var(--bid)" />
      <path d="M14 14h2v6h-2zM17 10h2v10h-2zM20 6h2v14h-2z" fill="var(--ask)" />
      <path d="M12 3v18" stroke="currentColor" strokeWidth="1.25" strokeDasharray="1.5 1.5" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-semibold tracking-[-0.02em] ${className}`}
    >
      <LogoMark />
      <span>MarketLab</span>
    </span>
  );
}
