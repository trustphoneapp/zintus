"use client";

import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

interface InteractiveCardProps {
  children: ReactNode;
  /** Extra classes appended after `mk-card` (and `mk-spot`/`mk-tilt`). */
  className?: string;
  /** Adds a ≤3deg perspective tilt that springs back on leave. Default off. */
  tilt?: boolean;
  /** Cursor-tracking radial highlight. Default on. */
  spotlight?: boolean;
  style?: CSSProperties;
  id?: string;
}

/**
 * The machined-dark card as a client wrapper: on pointer-move it writes the
 * cursor position into `--mx`/`--my` (px, card-relative) that `.mk-spot` reads
 * for its radial highlight, and — when `tilt` is set — a capped ±3deg rotation
 * into `--rx`/`--ry`. Under prefers-reduced-motion the handlers are inert and no
 * motion classes are applied, so the card is a plain static `.mk-card`.
 */
export function InteractiveCard({
  children,
  className = "",
  tilt = false,
  spotlight = true,
  style,
  id,
}: InteractiveCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (reduced) return;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      el.style.setProperty("--mx", `${x}px`);
      el.style.setProperty("--my", `${y}px`);
      if (tilt) {
        // Normalize to -0.5..0.5, scale by 6 → capped at ±3deg.
        const px = x / r.width - 0.5;
        const py = y / r.height - 0.5;
        el.style.setProperty("--rx", `${(-py * 6).toFixed(2)}deg`);
        el.style.setProperty("--ry", `${(px * 6).toFixed(2)}deg`);
      }
    },
    [reduced, tilt],
  );

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el || !tilt) return;
    // Spring back to flat (200ms transition lives on .mk-tilt).
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  }, [tilt]);

  const classes = [
    "mk-card",
    spotlight && !reduced ? "mk-spot" : "",
    tilt && !reduced ? "mk-tilt" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={ref}
      id={id}
      className={classes}
      style={style}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      {children}
    </div>
  );
}
