"use client";

const PROVIDERS_ROW1 = [
  { name: "Cerebras", badge: "1M tok/day", color: "#f59e0b" },
  { name: "Groq 70B", badge: "1K req/day", color: "#8b5cf6" },
  { name: "Groq 8B", badge: "14.4K req/day", color: "#a78bfa" },
  { name: "Gemini Flash", badge: "1.5K req/day", color: "#3b82f6" },
  { name: "DeepSeek", badge: "MIT free", color: "#22c55e" },
  { name: "OpenRouter", badge: "50 req/day", color: "#ec4899" },
];

const PROVIDERS_ROW2 = [
  { name: "Cohere", badge: "1K/month", color: "#14b8a6" },
  { name: "Mistral", badge: "~1B tok/mo", color: "#f97316" },
  { name: "Fireworks", badge: "$1 free", color: "#eab308" },
  { name: "xAI Grok", badge: "trial", color: "#94a3b8" },
  { name: "Ollama", badge: "unlimited local", color: "#34d399" },
  { name: "LM Studio", badge: "unlimited local", color: "#60a5fa" },
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
        background: "rgba(13,8,32,0.8)",
        border: "1px solid rgba(124,58,237,0.2)",
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
      <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{name}</span>
      <span
        style={{
          fontSize: 11,
          color: "#4a3070",
          background: "rgba(124,58,237,0.1)",
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
          <h2 className="m-title">12 providers. All free tiers.</h2>
          <p className="m-subtitle">
            Economy routing picks the cheapest provider with quota left — automatically.
            When one runs out, the next takes over in under 5ms.
          </p>
        </div>
      </div>
      {/* Full-width marquee, outside shell */}
      <MarqueeRow providers={PROVIDERS_ROW1} />
      <MarqueeRow providers={PROVIDERS_ROW2} reverse />
      <div className="m-shell" style={{ marginTop: "2rem" }}>
        <p style={{ textAlign: "center", fontSize: 12, color: "#4a3070" }}>
          Priority: Cerebras → Groq 70B → Groq 8B → Gemini → DeepSeek → OpenRouter → Cohere →
          Mistral → Ollama
        </p>
      </div>
    </section>
  );
}
