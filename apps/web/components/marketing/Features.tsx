"use client";

import { Infinity as InfinityIcon, Lock, MonitorSmartphone, Wallet } from "lucide-react";
import { Reveal } from "./Reveal";

const features = [
  {
    icon: InfinityIcon,
    title: "Keep chatting when one runs out",
    body: "Free AIs run out of usage quickly. Zintus watches all 12 and switches automatically when another provider has quota left.",
  },
  {
    icon: Wallet,
    title: "Spend nothing to start",
    body: "It uses the free tiers of each service. No subscription, no credit card — bring the free keys you already have.",
  },
  {
    icon: Lock,
    title: "Your keys stay private",
    body: "API keys are saved securely on your own device, never on our servers. You stay in full control.",
  },
  {
    icon: MonitorSmartphone,
    title: "Works everywhere",
    body: "Use it in your browser, on the desktop app, on your phone, or right in the terminal — same chat, same keys.",
  },
];

export function Features() {
  return (
    <section className="m-section" id="features">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Why people use it</p>
          <h2 className="m-title">All the free AI, none of the hassle</h2>
        </Reveal>
        <div className="m-feature-grid">
          {features.map((feature, index) => (
            <Reveal key={feature.title} delay={index * 0.08}>
              <article className="m-panel">
                <feature.icon size={18} />
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
