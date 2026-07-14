"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

/**
 * Scroll-reveal via a single shared IntersectionObserver (one instance for the
 * whole page, not one-per-element). On first intersection the element fades in
 * and rises translateY(12px)→0 over 500ms, after an optional `delay` (seconds —
 * pass `i * 0.06` for a 60ms stagger across siblings). Under reduced-motion the
 * content renders in its final state with no transition.
 */

type Cb = () => void;

let sharedObserver: IntersectionObserver | null = null;
const callbacks = new WeakMap<Element, Cb>();

function getObserver(): IntersectionObserver | null {
  if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
    return null;
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            callbacks.get(entry.target)?.();
            sharedObserver?.unobserve(entry.target);
            callbacks.delete(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
  }
  return sharedObserver;
}

export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  /** Stagger delay in seconds (e.g. `i * 0.06`). */
  delay?: number;
  /** Extra classes on the reveal wrapper (e.g. a grid-span for bento layout). */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const observer = getObserver();
    if (!observer) {
      setVisible(true);
      return;
    }
    callbacks.set(el, () => setVisible(true));
    observer.observe(el);
    return () => {
      observer.unobserve(el);
      callbacks.delete(el);
    };
  }, [reduced]);

  return (
    <div
      ref={ref}
      className={`mk-reveal${visible ? " is-visible" : ""}${className ? ` ${className}` : ""}`}
      style={reduced ? undefined : { transitionDelay: `${delay}s` }}
    >
      {children}
    </div>
  );
}
