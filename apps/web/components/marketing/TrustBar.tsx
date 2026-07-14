// A single-row infinite marquee of routed providers (names + status dots),
// replacing the old static trust chips. The list is duplicated so the CSS
// translateX(-50%) loop is seamless; `.marquee-track:hover` pauses it and the
// `.marquee-wrap` mask fades both edges. Pure CSS motion — no JS ticker.
const PROVIDERS = [
  { name: "Cerebras", color: "#f59e0b" },
  { name: "Groq", color: "#f97316" },
  { name: "Google AI", color: "#60a5fa" },
  { name: "DeepSeek", color: "#4d6bfe" },
  { name: "Mistral", color: "#fb923c" },
  { name: "Together", color: "#2dd4bf" },
  { name: "Fireworks", color: "#ec4899" },
  { name: "OpenRouter", color: "#a3a3a3" },
  { name: "xAI", color: "#e5e5e5" },
  { name: "Cohere", color: "#38bdf8" },
  { name: "Ollama", color: "#34d399" },
  { name: "LM Studio", color: "#818cf8" },
];

export function TrustBar() {
  const doubled = [...PROVIDERS, ...PROVIDERS];
  return (
    <section className="m-band trust-marquee-band">
      <div className="marquee-wrap">
        <div className="marquee-track">
          {doubled.map((p, i) => (
            <span key={i} className="trust-marquee-item">
              <span className="trust-marquee-dot" style={{ background: p.color }} />
              {p.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
