/**
 * The terminal's overflow menu: where this project is explained, where its
 * source lives, and a way to start again with a fresh account.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";

import { DECISIONS, REPO } from "../lib/links";

const ITEM =
  "flex h-9 w-full items-center justify-between gap-3 px-3 text-left text-sm text-text hover:bg-raised focus-visible:bg-raised focus-visible:outline-none";

function NewTab() {
  return (
    <>
      <svg viewBox="0 0 12 12" className="size-3 text-muted" aria-hidden="true">
        <path d="M4.5 2.5h5v5M9.5 2.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </svg>
      <span className="sr-only">(opens in a new tab)</span>
    </>
  );
}

export function HeaderMenu({ onStartOver }: { onStartOver: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onMenuKey = (event: React.KeyboardEvent) => {
    // While the menu is open its keys are its own; B or S must not flip the order ticket.
    event.stopPropagation();
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(all.length - 1);
    else if (event.key === "Escape") close(true);
    else if (event.key === "Tab") setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className={`flex size-8 items-center justify-center rounded-md hover:bg-raised hover:text-text ${
          open ? "bg-raised text-text" : "text-muted"
        }`}
      >
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true" fill="currentColor">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="More"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-40 mt-1.5 w-64 overflow-hidden rounded-md border border-line bg-surface py-1 shadow-[0_16px_32px_-12px_rgb(0_0_0/0.6)]"
        >
          <Link role="menuitem" tabIndex={-1} to="/" className={ITEM}>
            How it works
          </Link>
          <Link role="menuitem" tabIndex={-1} to="/replay" className={ITEM}>
            Replay this session
          </Link>
          <a
            role="menuitem"
            tabIndex={-1}
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className={ITEM}
          >
            Source on GitHub
            <NewTab />
          </a>
          <a
            role="menuitem"
            tabIndex={-1}
            href={DECISIONS}
            target="_blank"
            rel="noreferrer"
            className={ITEM}
          >
            Design decisions
            <NewTab />
          </a>
          <div role="separator" className="my-1 border-t border-line" />
          <button
            role="menuitem"
            tabIndex={-1}
            type="button"
            className={ITEM}
            onClick={() => {
              // Focus goes back to the menu button first, so the dialog returns it there.
              close(true);
              onStartOver();
            }}
          >
            Start over with a new account
          </button>
        </div>
      )}
    </div>
  );
}
