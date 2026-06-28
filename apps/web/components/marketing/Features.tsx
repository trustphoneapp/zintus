"use client";

import {
  Zap,
  Key,
  Wrench,
  Braces,
  Image as ImageIcon,
  Coins,
  Shuffle,
  BarChart2,
  Terminal,
} from "lucide-react";
import { Reveal } from "./Reveal";

const FEATURES = [
  {
    icon: Zap,
    color: "#f59e0b",
    title: "Sub-5ms routing",
    body: "An in-process quota check picks the fastest provider with tokens left — no extra network hop, no proxy in the middle.",
  },
  {
    icon: Shuffle,
    color: "#3b82f6",
    title: "Automatic failover",
    body: "When a provider hits its limit, the next in your priority order takes over. Exhaust the cloud and Ollama or LM Studio answers locally.",
  },
  {
    icon: Key,
    color: "#7c3aed",
    title: "Your keys. Your device.",
    body: "Keys live in your OS keychain or browser secure storage — never in our custody. Requests go straight from your machine to each provider.",
  },
  {
    icon: Wrench,
    color: "#34d399",
    title: "Tool calling (API & CLI)",
    body: "Define tools once; Zintus maps them to each provider's native format and routes only to models that support function calling. Available today via the gateway API and the CLI (--tools) — the web chat tool UI is on the way.",
  },
  {
    icon: Braces,
    color: "#ec4899",
    title: "Structured output (API & CLI)",
    body: "Ask for JSON via the gateway API or CLI: schema-constrained decoding where the provider guarantees it (Gemini), best-effort JSON mode elsewhere. Not yet exposed in the web chat UI.",
  },
  {
    icon: ImageIcon,
    color: "#22c55e",
    title: "Image input",
    body: "Send images to vision-capable models. EXIF and GPS metadata are stripped on-device before anything is sent.",
  },
  {
    icon: Coins,
    color: "#eab308",
    title: "Savings ledger",
    body: "Every free-tier token is valued against what a metered API would have billed, so you can see your estimated savings add up.",
  },
  {
    icon: BarChart2,
    color: "#60a5fa",
    title: "Live quota tracking",
    body: "Real-time RPM and TPM windows per provider mean Zintus switches before you hit a wall — not after a failed request.",
  },
  {
    icon: Terminal,
    color: "#c4b5fd",
    title: "CLI + Web + Desktop",
    body: "A terminal-first CLI, a browser chat, and a native Tauri desktop app (beta) — all driven by one BYOK config.",
  },
];

export function Features() {
  return (
    <section className="m-section" id="features">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Features</p>
          <h2 className="m-title">A real router, not just a key vault.</h2>
          <p className="m-subtitle" style={{ marginBottom: "2.5rem" }}>
            Multi-provider routing and failover with image input in chat, plus tool calling and
            structured output via the API &amp; CLI — all running against your own keys, on your own
            machine.
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
