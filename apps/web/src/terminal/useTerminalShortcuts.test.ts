// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTerminalShortcuts } from "./useTerminalShortcuts";

function setup() {
  const handlers = { onToggleInspector: vi.fn(), onShowShortcuts: vi.fn() };
  const hook = renderHook(() => {
    useTerminalShortcuts(handlers);
  });
  return { ...handlers, ...hook };
}

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe("useTerminalShortcuts", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("toggles the inspector with I in either case and lists shortcuts with ?", () => {
    const { onToggleInspector, onShowShortcuts } = setup();
    expect(press("i").defaultPrevented).toBe(true);
    press("I");
    press("?");
    press("x");
    expect(onToggleInspector).toHaveBeenCalledTimes(2);
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it("ignores keys pressed with a modifier, or while typing in a field", () => {
    const { onToggleInspector, onShowShortcuts } = setup();
    press("i", { ctrlKey: true });
    press("i", { metaKey: true });
    press("?", { altKey: true });
    const input = document.body.appendChild(document.createElement("input"));
    press("i", {}, input);
    press("?", {}, input);
    expect(onToggleInspector).not.toHaveBeenCalled();
    expect(onShowShortcuts).not.toHaveBeenCalled();
  });

  it("stops listening when the terminal unmounts", () => {
    const { onToggleInspector, unmount } = setup();
    unmount();
    press("i");
    expect(onToggleInspector).not.toHaveBeenCalled();
  });
});
