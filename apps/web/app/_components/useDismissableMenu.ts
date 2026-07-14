"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Consistent dismissal for lightweight popovers/menus (NOT modal dialogs — those
 * use `useFocusTrap`). Given the open flag, a `close` callback, and a ref to the
 * container that wraps BOTH the trigger and the popover, it wires three exits:
 *
 *   - pointer — mousedown outside the container closes it (unchanged behavior);
 *   - Escape — closes AND returns focus to the trigger (the element carrying
 *     `aria-haspopup` / `aria-expanded`), so keyboard users land back where they
 *     opened from;
 *   - focusout — when focus leaves the container subtree entirely (tabbed or
 *     clicked away), the menu closes; focus is left where the user moved it.
 *
 * `close` is held in a ref so the effect depends only on `open` — an inline
 * `() => setOpen(false)` at the call site won't churn the listeners each render.
 */
export function useDismissableMenu(
  open: boolean,
  close: () => void,
  containerRef: RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    if (!containerRef.current) return;
    // Explicit non-null binding so the hoisted closures below see `el` as
    // HTMLElement (control-flow narrowing on `.current` doesn't reach into them).
    const el: HTMLElement = containerRef.current;

    function onPointerDown(event: MouseEvent) {
      if (!el.contains(event.target as Node)) closeRef.current();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // The trigger always carries aria-haspopup (or at least aria-expanded);
      // grab it before closing so we can restore focus after the menu unmounts.
      const trigger =
        el.querySelector<HTMLElement>("[aria-haspopup]") ??
        el.querySelector<HTMLElement>("[aria-expanded]");
      closeRef.current();
      trigger?.focus();
    }

    function onFocusOut(event: FocusEvent) {
      const next = event.relatedTarget as Node | null;
      // Only close when focus actually left the subtree (tab/click away). A null
      // relatedTarget (blur to nowhere, e.g. a click on non-focusable chrome) is
      // left to the pointer handler so we don't close on transient blurs.
      if (next && !el.contains(next)) closeRef.current();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, [open, containerRef]);
}
