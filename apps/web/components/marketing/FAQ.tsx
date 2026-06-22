"use client";

import { Plus } from "lucide-react";
import { Reveal } from "./Reveal";

const faqs = [
  {
    q: "Is it really free?",
    a: "Yes. Zintus uses the free tiers of each AI service, and the app itself is free to use. You only pay if you choose to upgrade a provider's plan yourself.",
  },
  {
    q: "Are my API keys safe?",
    a: "Yes. Your keys are stored securely on your own device — in your browser's encrypted storage, your computer's keychain, or your phone's secure store. They are never sent to our servers.",
  },
  {
    q: "Do I need to be a developer?",
    a: "No. The web and desktop apps work like any normal chat app. Developers also get a command-line tool and a self-hostable gateway if they want them.",
  },
  {
    q: "What happens when a free AI runs out?",
    a: "Zintus tracks each service's usage and automatically switches to another available one when a provider is exhausted.",
  },
  {
    q: "Which AIs are supported?",
    a: "12 services today: Cerebras, Groq, Gemini, OpenRouter, Cohere, Mistral, DeepSeek, Fireworks AI, xAI Grok, and Hugging Face in the cloud, plus LM Studio and Ollama running on your own computer.",
  },
  {
    q: "Is it open source?",
    a: "Zintus is source-available under the Business Source License 1.1 — you can self-host it for personal or internal use at no cost. It's not an OSI open-source license; commercial hosting or resale needs a separate license.",
  },
];

export function FAQ() {
  return (
    <section className="m-section" id="faq">
      <div className="m-shell m-faq-shell">
        <Reveal>
          <p className="m-eyebrow">Questions &amp; answers</p>
          <h2 className="m-title">Frequently asked questions</h2>
        </Reveal>
        <div className="m-faq">
          {faqs.map((item, index) => (
            <Reveal key={item.q} delay={index * 0.05}>
              <details className="m-faq-item">
                <summary>
                  <span>{item.q}</span>
                  <Plus size={18} className="m-faq-icon" aria-hidden />
                </summary>
                <p>{item.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
