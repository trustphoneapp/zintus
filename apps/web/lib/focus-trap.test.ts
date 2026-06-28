import { describe, expect, test } from "bun:test";
import { trapTabTarget } from "./focus-trap";

// Pure Tab-cycling math behind the consent-dialog focus trap. Drives the
// keyboard a11y fix (the DOM hook is in app/_components/useFocusTrap.ts).
describe("trapTabTarget", () => {
  test("no focusable elements → never traps", () => {
    expect(trapTabTarget(0, -1, false)).toBeNull();
    expect(trapTabTarget(0, 0, true)).toBeNull();
  });

  test("Tab off the last element wraps to the first", () => {
    expect(trapTabTarget(3, 2, false)).toBe(0);
  });

  test("Shift+Tab off the first element wraps to the last", () => {
    expect(trapTabTarget(3, 0, true)).toBe(2);
  });

  test("interior Tab / Shift+Tab is left to the browser (null)", () => {
    expect(trapTabTarget(3, 1, false)).toBeNull(); // Tab from middle
    expect(trapTabTarget(3, 1, true)).toBeNull(); // Shift+Tab from middle
    expect(trapTabTarget(3, 0, false)).toBeNull(); // Tab from first → 2nd
    expect(trapTabTarget(3, 2, true)).toBeNull(); // Shift+Tab from last → 2nd
  });

  test("focus outside the trap is pulled to the near edge", () => {
    expect(trapTabTarget(3, -1, false)).toBe(0); // Tab → first
    expect(trapTabTarget(3, -1, true)).toBe(2); // Shift+Tab → last
  });

  test("single focusable element always wraps to itself", () => {
    expect(trapTabTarget(1, 0, false)).toBe(0);
    expect(trapTabTarget(1, 0, true)).toBe(0);
  });
});
