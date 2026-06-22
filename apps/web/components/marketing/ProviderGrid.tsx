"use client";

import { Reveal } from "./Reveal";

const providers = [
  { name: "Cerebras", tier: "Super fast", limit: "1M tokens/day", fill: "82%" },
  { name: "Groq", tier: "Super fast", limit: "1,000 req/day", fill: "70%" },
  { name: "Gemini", tier: "Balanced", limit: "1,500 req/day", fill: "75%" },
  { name: "OpenRouter", tier: "Balanced", limit: "50 req/day", fill: "45%" },
  { name: "Cohere", tier: "Balanced", limit: "1,000 req/month", fill: "55%" },
  { name: "Mistral", tier: "Balanced", limit: "1 req/sec", fill: "50%" },
  { name: "DeepSeek", tier: "Powerful", limit: "Free off-peak hours", fill: "60%" },
  { name: "Fireworks AI", tier: "Powerful", limit: "$1 free credit", fill: "40%" },
  { name: "xAI Grok", tier: "Powerful", limit: "Free trial credits", fill: "35%" },
  { name: "Hugging Face", tier: "Powerful", limit: "Free inference API", fill: "65%" },
  { name: "LM Studio", tier: "Runs on your PC", limit: "Unlimited, local", fill: "100%" },
  { name: "Ollama", tier: "Runs on your PC", limit: "Unlimited, local", fill: "100%" },
];

export function ProviderGrid() {
  return (
    <section className="m-section" id="providers">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Supported AIs</p>
          <h2 className="m-title">12 AI services. One chat box.</h2>
          <p className="m-subtitle">
            Mix fast cloud models with private models that run on your own computer. Turn on
            the ones you want &mdash; Zintus picks the best one for each message.
          </p>
        </Reveal>
        <div className="m-provider-grid">
          {providers.map((provider, index) => (
            <Reveal key={provider.name} delay={index * 0.03}>
              <article className="m-provider-card">
                <h3>{provider.name}</h3>
                <span>{provider.tier}</span>
                <div className="m-provider-quota" aria-hidden="true">
                  <span className="m-provider-quota-fill" style={{ width: provider.fill }} />
                </div>
                <span className="m-provider-limit">{provider.limit}</span>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
