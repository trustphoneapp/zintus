"use client";

import { Zap, Key, Wifi, BarChart2, Terminal, ShieldCheck } from "lucide-react";
import { Reveal } from "./Reveal";

const FEATURES = [
  {
    icon: Zap,
    color: "#f59e0b",
    title: "< 5ms routing",
    body: "In-process quota check. Picks the fastest available provider without an extra network hop.",
  },
  {
    icon: Key,
    color: "#7c3aed",
    title: "Your keys. Your device.",
    body: "API keys stored in OS keychain via keyring. Zero-knowledge relay — Zintus never sees them.",
  },
  {
    icon: Wifi,
    color: "#22c55e",
    title: "Offline fallback",
    body: "When all cloud providers are exhausted, Ollama takes over. Always have a response.",
  },
  {
    icon: BarChart2,
    color: "#3b82f6",
    title: "Quota tracking",
    body: "Real-time RPM/TPM windows per provider. Auto-switches before you hit a wall.",
  },
  {
    icon: Terminal,
    color: "#c4b5fd",
    title: "CLI + Web + Desktop",
    body: "Terminal-first CLI, browser-based web chat, and a native Tauri desktop app — one config.",
  },
  {
    icon: ShieldCheck,
    color: "#34d399",
    title: "OWASP LLM01 hardened",
    body: "Context blocks delivered as user-role untrusted data. Prompt injection mitigated by design.",
  },
];

export function Features() {
  return (
    <section className="m-section" id="features">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Features</p>
          <h2 className="m-title">Everything a developer needs.</h2>
          <p className="m-subtitle" style={{ marginBottom: "2.5rem" }}>
            Built for the terminal. Works everywhere. No config files, no cloud dependency.
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
