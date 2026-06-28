"use client";

import {
  Zap,
  Key,
  Coins,
  Shuffle,
  BarChart2,
  Terminal,
} from "lucide-react";
import { Reveal } from "./Reveal";

const FEATURES = [
  {
    icon: Coins,
    color: "#eab308",
    title: "Exact token balance",
    body: "Your monthly token budget is a fixed number, shown before you subscribe and visible after every message. It doesn't shrink at peak hours or change based on which model you use.",
  },
  {
    icon: BarChart2,
    color: "#60a5fa",
    title: "No silent downgrades",
    body: "Some AI products swap your model when you hit a limit and don't tell you. Zintus shows which model handled every request. If your budget runs low, we warn you — we never quietly change what you're getting.",
  },
  {
    icon: Shuffle,
    color: "#3b82f6",
    title: "Smart routing, real savings",
    body: "Zintus classifies each request and routes to the best-value provider automatically. Short queries go to the fastest model. Long contexts go to the widest window. Reasoning tasks go to the strongest reasoner.",
  },
  {
    icon: Key,
    color: "#7c3aed",
    title: "Your keys stay on your device",
    body: "BYOK keys are stored in your OS keychain or browser's encrypted storage. They go directly from your device to the provider — Zintus never sees them. Managed tier keys are Zintus-provided and stay server-side.",
  },
  {
    icon: Terminal,
    color: "#c4b5fd",
    title: "50+ providers, one interface",
    body: "Route across 20+ direct integrations and 70+ more via a model-aggregator key. One config, one dashboard, one token balance — regardless of which provider handles the request.",
  },
  {
    icon: Zap,
    color: "#f59e0b",
    title: "BYOK frontier on any plan",
    body: "Add your own key for any frontier model on any paid tier. Route to the most powerful models available at direct provider rates — zero markup, zero restrictions, deducted from your own credits not your Zintus quota.",
  },
];

export function Features() {
  return (
    <section className="m-section" id="features">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Features</p>
          <h2 className="m-title">A router built around what you actually bought.</h2>
          <p className="m-subtitle" style={{ marginBottom: "2.5rem" }}>
            Routing, billing, and key handling are built around one idea: you always
            know which model answered, what it cost, and how much budget is left.
          </p>
        </Reveal>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1px",
            background: "rgba(124,58,237,0.12)",
            border: "1px solid rgba(124,58,237,0.12)",
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delay={i * 0.06}>
              <div
                className="glass-card"
                style={{ borderRadius: 0, border: "none", padding: "1.75rem" }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: `${feature.color}18`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: "1rem",
                  }}
                >
                  <feature.icon size={20} color={feature.color} />
                </div>
                <h3
                  style={{
                    fontSize: "0.95rem",
                    fontWeight: 700,
                    color: "#f1f5f9",
                    marginBottom: "0.5rem",
                  }}
                >
                  {feature.title}
                </h3>
                <p style={{ fontSize: "0.85rem", color: "#64748b", lineHeight: 1.7 }}>
                  {feature.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
