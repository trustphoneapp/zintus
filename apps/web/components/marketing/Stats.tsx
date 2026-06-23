"use client";

const STATS = [
  { value: "12",    suffix: "",   label: "AI providers" },
  { value: "1M",    suffix: "+",  label: "Free tokens/day" },
  { value: "< 5",   suffix: "ms", label: "Routing latency" },
  { value: "0",     suffix: "%",  label: "Markup on keys" },
];

export function Stats() {
  return (
    <section className="stats-v2">
      <div className="m-shell">
        <div className="stats-v2-grid">
          {STATS.map((stat) => (
            <div key={stat.label} className="stats-v2-item">
              <span className="stats-v2-value">
                {stat.value}<span style={{ fontSize: "0.6em", opacity: 0.7 }}>{stat.suffix}</span>
              </span>
              <span className="stats-v2-label">{stat.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
