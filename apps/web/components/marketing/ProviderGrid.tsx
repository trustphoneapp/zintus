"use client";

import { Reveal } from "./Reveal";

const providers = [
  { name: "Cerebras", tier: "Super fast" },
  { name: "Groq", tier: "Super fast" },
  { name: "Gemini", tier: "Balanced" },
  { name: "OpenRouter", tier: "Balanced" },
  { name: "Cohere", tier: "Balanced" },
  { name: "Mistral", tier: "Balanced" },
  { name: "DeepSeek", tier: "Powerful" },
  { name: "Fireworks AI", tier: "Powerful" },
  { name: "xAI Grok", tier: "Powerful" },
  { name: "Hugging Face", tier: "Powerful" },
  { name: "LM Studio", tier: "Runs on your PC" },
  { name: "Ollama", tier: "Runs on your PC" },
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
            the ones you want &mdash; MultipleAI picks the best one for each message.
          </p>
        </Reveal>
        <div className="m-provider-grid">
          {providers.map((provider, index) => (
            <Reveal key={provider.name} delay={index * 0.03}>
              <article className="m-provider-card">
                <h3>{provider.name}</h3>
                <span>{provider.tier}</span>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
