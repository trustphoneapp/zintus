"use client";

const PROVIDERS_ROW1 = [
  { name: "Ultra-fast inference", badge: "1M tok/day", color: "#f59e0b" },
  { name: "70B · low latency", badge: "1K req/day", color: "#2dd4bf" },
  { name: "8B · high volume", badge: "14.4K req/day", color: "#38bdf8" },
  { name: "Fast multimodal", badge: "1.5K req/day", color: "#3b82f6" },
  { name: "Open reasoning", badge: "MIT free", color: "#22c55e" },
  { name: "Model aggregator", badge: "300+ models", color: "#ec4899" },
];

const PROVIDERS_ROW2 = [
  { name: "Enterprise NLP", badge: "1K/month", color: "#14b8a6" },
  { name: "Open weights", badge: "~1B tok/mo", color: "#f97316" },
  { name: "Serverless inference", badge: "$1 free", color: "#eab308" },
  { name: "Frontier trial", badge: "trial", color: "var(--marketing-muted)" },
  { name: "Local runtime", badge: "unlimited local", color: "#34d399" },
  { name: "Local desktop", badge: "unlimited local", color: "#60a5fa" },
];

const TIERS = [
  { label: "Tier 0 — Default", sub: "94–99% margin · < $0.30/M", color: "#22c55e" },
  { label: "Tier 1 — Capable", sub: "70–85% margin · $1–3/M", color: "#3b82f6" },
  { label: "Tier 2 — Ceiling", sub: "Top-tier reasoning model · hard cap", color: "#f97316" },
];

function ProviderChip({
  name,
  badge,
  color,
}: {
  name: string;
  badge: string;
  color: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 18px",
        borderRadius: 10,
        background: "var(--marketing-surface)",
        border: "1px solid var(--marketing-border)",
        marginRight: 12,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--marketing-text)" }}>{name}</span>
      <span
        style={{
          fontSize: 11,
          color: "var(--marketing-muted)",
          background: "var(--marketing-accent-soft)",
          padding: "2px 8px",
          borderRadius: 4,
        }}
      >
        {badge}
      </span>
    </div>
  );
}

function MarqueeRow({
  providers,
  reverse,
}: {
  providers: typeof PROVIDERS_ROW1;
  reverse?: boolean;
}) {
  const doubled = [...providers, ...providers];
  return (
    <div className="marquee-wrap" style={{ marginBottom: 12 }}>
      <div
        className="marquee-track"
        style={reverse ? { animationDirection: "reverse" } : {}}
      >
        {doubled.map((p, i) => (
          <ProviderChip key={i} {...p} />
        ))}
      </div>
    </div>
  );
}

export function ProviderGrid() {
  return (
    <section className="m-section" id="providers" style={{ overflow: "hidden" }}>
      <div className="m-shell">
        <div style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          <p className="m-eyebrow">Supported providers</p>
          <h2 className="m-title">20+ providers. 100+ models. Smarter every month.</h2>
          <p className="m-subtitle">
            Free tier routes across 12+ providers with real-time quota tracking. Add a
            model-aggregator key to reach 300+ models instantly. Managed tiers use
            Zintus-provided keys across our curated routing roster.
          </p>
        </div>
      </div>
      {/* Full-width marquee, outside shell */}
      <MarqueeRow providers={PROVIDERS_ROW1} />
      <MarqueeRow providers={PROVIDERS_ROW2} reverse />
      <div className="m-shell" style={{ marginTop: "2rem" }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: 12,
          }}
        >
          {TIERS.map((tier) => (
            <div
              key={tier.label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 16px",
                borderRadius: 10,
                background: "var(--marketing-surface)",
                border: `1px solid ${tier.color}40`,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: tier.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--marketing-text)" }}>
                {tier.label}
              </span>
              <span style={{ fontSize: 11, color: "var(--marketing-muted)" }}>{tier.sub}</span>
            </div>
          ))}
        </div>
        <div style={{ textAlign: "center", marginTop: "1.75rem" }}>
          <a
            href="/catalog"
            style={{ color: "var(--marketing-accent-light)", fontSize: 14, fontWeight: 600 }}
          >
            Browse the full catalog — every provider and model →
          </a>
        </div>
      </div>
    </section>
  );
}
