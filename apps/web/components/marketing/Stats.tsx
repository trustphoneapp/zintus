"use client";

const STATS = [
  { value: "50+",   suffix: " providers", label: "Direct + meta-router catalog" },
  { value: "100+",  suffix: " models",    label: "Curated and growing weekly" },
  { value: "< 5ms", suffix: " routing",   label: "In-process quota check" },
  { value: "0%",    suffix: " markup",    label: "On your own API keys" },
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
