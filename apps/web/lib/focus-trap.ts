/**
 * Focus-trap primitives shared by accessible modal dialogs (ConsentDialog, …).
 *
 * The DOM-touching `useFocusTrap` hook lives in
 * `app/_components/useFocusTrap.ts`; the Tab-cycling math is kept here as a pure
 * function so it can be unit-tested without a DOM (the web tests are
 * node-environment / logic-only).
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Focusable descendants of `container`, in DOM (tab) order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
}

/**
 * Pure Tab-cycling math for a focus trap.
 *
 * Given the number of focusable elements, the index of the currently-focused
 * one (`-1` when focus is outside the trap), and whether Shift is held, returns
 * the index focus should move to when Tab would otherwise escape the trap — or
 * `null` to let the browser move focus naturally (the move stays inside).
 */
export function trapTabTarget(
  count: number,
  currentIndex: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return null;
  // Focus has escaped (or never entered) the trap → pull it to the near edge.
  if (currentIndex < 0) return shiftKey ? count - 1 : 0;
  // Shift+Tab off the first element wraps to the last; Tab off the last wraps
  // to the first. Interior moves are left to the browser.
  if (shiftKey && currentIndex === 0) return count - 1;
  if (!shiftKey && currentIndex === count - 1) return 0;
  return null;
}
