// Server Component: static Q&A rendered with native <details>/<summary>
// (no JS accordion), wrapped in the <Reveal> client island.
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
    a: "20+ providers today across direct integrations — ultra-fast inference, large reasoning models, fast multimodal, and enterprise NLP in the cloud — plus local runtimes on your own computer. Add a model-aggregator key to reach 300+ more models.",
  },
  {
    q: "Is it open source?",
    a: "Zintus is source-available under the Business Source License 1.1 — you can self-host it for personal or internal use at no cost. It's not an OSI open-source license; commercial hosting or resale needs a separate license.",
  },
  {
    q: "How is this different from a paid API proxy?",
    a: "A typical API proxy adds a markup on every call and sits between you and the provider. Zintus is a local router — your requests go directly to each provider from your machine, with zero markup and no middleman. We add smart quota tracking, automatic fallback, and token compression on top.",
  },
  {
    q: "Can I use it with a single API key?",
    a: "Yes. Even one key gives you up to 1,500 free requests a day with search grounding built in. Add more keys over time — each one multiplies your free quota.",
  },
  {
    q: "Is my data private?",
    a: "Your prompts go directly from your device to the AI provider — Zintus never sees them. API keys are stored in your OS keychain or browser's encrypted storage, not on our servers.",
  },
  {
    q: "Does it work offline?",
    a: "Yes. When all cloud providers are exhausted, Zintus automatically falls back to a local runtime on your own machine. You always get a response.",
  },
  {
    q: "Does it support tool calling, JSON output, and images?",
    a: "Yes. Define tools once and Zintus maps them to each provider's native function-calling format, routing only to models that support it. Ask for structured output and you get JSON — schema-constrained where the provider guarantees it, best-effort JSON mode elsewhere. You can also send images to vision-capable models; EXIF and GPS metadata are stripped on your device first.",
  },
  {
    q: "How do I know how much I'm saving?",
    a: "Zintus keeps a usage ledger and values every free-tier token against what a metered API would have charged for the same model. The dashboard shows the running estimate — it's an approximation for display, not a bill, but it's based on your real usage.",
  },
  {
    q: "What's the difference between BYOK and managed tiers?",
    a: "On the free BYOK tier, you supply your own API keys. They stay on your device and requests go directly to providers — Zintus never sees them. On managed tiers ($15–$199/mo), Zintus provides the keys. You get an exact monthly token budget and we handle routing, quota tracking, and automatic fallback.",
  },
  {
    q: "Can I use frontier models on a managed plan?",
    a: "Yes — via BYOK on top. Add your own provider key to any paid tier and we route frontier requests through your key at zero markup. Your managed budget handles everything else. You get both: a predictable monthly budget and access to the most powerful models available.",
  },
  {
    q: "Why do you charge in tokens instead of messages or credits?",
    a: "Tokens are the actual unit of work in every AI system. Messages and credits are abstractions layered on top — designed to make limits harder to compare. We skip the abstraction. You see the real number.",
  },
  {
    q: "What happens when I run out of tokens?",
    a: "You'll see your balance in real time throughout the month. When it runs low we warn you. When it hits zero, requests stop — no surprise overages. You can top up with an add-on, or add your own API key to continue at direct provider rates with no Zintus markup.",
  },
];

export function FAQ() {
  return (
    <section className="m-section m-band m-cv" id="faq">
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
