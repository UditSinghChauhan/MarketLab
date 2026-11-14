import type { ReactNode } from "react";

export function Panel({
  title,
  aside,
  children,
  className = "",
  bodyClassName = "",
  id,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`flex min-h-0 min-w-0 flex-col bg-surface ${className}`}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
        <h2 id={id} className="text-xs font-medium text-muted">
          {title}
        </h2>
        {aside}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded border border-line bg-raised px-1 font-sans text-2xs leading-none text-muted">
      {children}
    </kbd>
  );
}
