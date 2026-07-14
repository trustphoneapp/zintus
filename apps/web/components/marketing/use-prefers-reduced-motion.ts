"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Tracks the user's prefers-reduced-motion setting. Returns `true` when motion
 * should be suppressed. SSR-safe: starts `false`, syncs on mount, and follows
 * live changes. Every marketing interactive layer (spotlight, tilt, magnetic,
 * typing loop, reveal) reads this to fall back to a static end-state.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    setReduced(mql.matches);
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
