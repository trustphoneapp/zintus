"use client";

import { useEffect, useRef, type RefObject } from "react";
import { getFocusableElements, trapTabTarget } from "@/lib/focus-trap";

/**
 * Accessible modal-dialog behavior for a container element:
 *   - focus trap — Tab / Shift+Tab cycle within the dialog;
 *   - Escape closes (calls `onEscape`);
 *   - initial focus — the first `[data-autofocus]` element, else the first
 *     focusable child, else the container itself (give it `tabIndex={-1}`);
 *   - focus restore — on close, focus returns to whatever was focused before
 *     the dialog opened (the trigger).
 *
 * Keyboard-only ergonomics; pointer behavior is untouched. The pure Tab math is
 * `trapTabTarget` (unit-tested in lib/focus-trap.test.ts).
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  // Hold the latest onEscape in a ref so the trap effect depends only on
  // `active` — otherwise a new inline closure each render would re-run the
  // effect and yank focus back to the initial element mid-interaction.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const initial =
      container.querySelector<HTMLElement>("[data-autofocus]") ??
      getFocusableElements(container)[0] ??
      container;
    initial.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const el = containerRef.current;
      if (!el) return;
      const focusable = getFocusableElements(el);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const current =
        document.activeElement instanceof HTMLElement
          ? focusable.indexOf(document.activeElement)
          : -1;
      const target = trapTabTarget(focusable.length, current, e.shiftKey);
      if (target !== null) {
        e.preventDefault();
        focusable[target]?.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [active, containerRef]);
}
