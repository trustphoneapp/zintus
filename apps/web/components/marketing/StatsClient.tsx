"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

export interface Stat {
  prefix: string;
  target: number;
  suffix: string; // e.g. "+", "ms", "%"
  unit: string; // small trailing label, e.g. " providers"
  label: string;
  caption: string; // mono uppercase sub-caption (V3 §8.3)
  featured?: boolean;
}

const DURATION = 600;

function Ticker({ stat, run }: { stat: Stat; run: boolean }) {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(reduced ? stat.target : 0);

  useEffect(() => {
    if (reduced || !run) {
      setValue(stat.target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setValue(Math.round(stat.target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, run, stat.target]);

  return (
    <span className="stats-v2-value">
      {stat.prefix}
      {value}
      {stat.suffix}
      <span className="stats-v2-unit">{stat.unit}</span>
    </span>
  );
}

/**
 * Client island for the stats band: owns the on-scroll count-up (a shared
 * IntersectionObserver arms the tickers). The catalog-derived numbers are
 * computed server-side and handed in as the `stats` prop, so the
 * data/providers.ts graph never reaches the client bundle.
 */
export function StatsClient({ stats }: { stats: Stat[] }) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || !("IntersectionObserver" in window)) {
      setRun(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setRun(true);
          obs.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <section className="stats-v2">
      <div className="m-shell" ref={sectionRef}>
        <div className="stats-v2-grid">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={`stats-v2-item mk-card${stat.featured ? " stat-featured" : ""}`}
            >
              <Ticker stat={stat} run={run} />
              <span className="stats-v2-label">{stat.label}</span>
              <span className="stats-v2-subcaption">{stat.caption}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
