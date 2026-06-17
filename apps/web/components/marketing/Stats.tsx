"use client";

import { Reveal } from "./Reveal";

const stats = [
  { value: "12", label: "Free AI services" },
  { value: "4", label: "Ways to use it" },
  { value: "$0", label: "To get started" },
  { value: "100%", label: "Open source" },
];

export function Stats() {
  return (
    <section className="m-section">
      <div className="m-shell">
        <div className="m-stats-grid">
          {stats.map((item, index) => (
            <Reveal key={item.label} delay={index * 0.07}>
              <article className="m-stat-card">
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
