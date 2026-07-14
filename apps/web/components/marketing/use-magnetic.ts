"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

/**
 * Magnetic drift: the returned ref's element translates up to `max` px toward
 * the cursor while hovered, springing back to rest on leave (the 200ms
 * transition lives on `.mk-magnetic`). Attach the ref to a WRAPPER around the
 * button — never the button itself — so the button keeps its own hover-lift and
 * press-scale transforms. Inert under prefers-reduced-motion. Used only on the
 * hero primary CTA and the navbar "Open app".
 */
export function useMagnetic<T extends HTMLElement = HTMLElement>(max = 4) {
  const ref = useRef<T>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const cx = Math.max(-1, Math.min(1, dx)) * max;
      const cy = Math.max(-1, Math.min(1, dy)) * max;
      el.style.transform = `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px)`;
    };
    const onLeave = () => {
      el.style.transform = "";
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.style.transform = "";
    };
  }, [reduced, max]);

  return ref;
}
