"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, Zap } from "lucide-react";

// The CLI is not yet published to a registry, so `npm i -g zintus` / `bun add -g`
// would 404. The honest, working path today is build-from-source with Bun (the
// CLI uses bun:sqlite). Keep this truthful until the package is actually live.
const INSTALL_CMD = "bun install && bun run --filter zintus build";

const TERMINAL_LINES = [
  { delay: 0,    type: "prompt", text: "zintus chat" },
  { delay: 600,  type: "route",  text: "→ routing across 12 providers..." },
  { delay: 1200, type: "ok",     text: "✓ routed → fast model  [42ms]" },
  { delay: 1600, type: "muted",  text: "  tokens: 1,247 · quota: 847K/1M remaining" },
  { delay: 2200, type: "ok",     text: "✓ response streamed in 1.2s" },
];

export function Hero() {
  const [copied, setCopied] = useState(false);
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    const timers = TERMINAL_LINES.map((line, i) =>
      window.setTimeout(() => setVisibleLines(i + 1), line.delay + 400)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  async function copyCmd() {
    await navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="hero-v2">
      <div className="m-shell">
        <div className="hero-v2-inner">
          {/* Badge */}
          <div className="hero-v2-eyebrow">
            <span className="badge-pill">
              <Zap size={11} />
              One subscription. Exact tokens. Zero surprises.
            </span>
          </div>

          {/* Headline */}
          <h1>
            The AI router that tells you<br />
            <em>exactly what you bought.</em>
          </h1>

          {/* Subheadline */}
          <p className="hero-v2-sub">
            Most AI subscriptions hide their limits behind rolling windows, compute
            credits, and message caps. Zintus gives you a number. It doesn&apos;t change.
          </p>

          {/* CTAs */}
          <div className="hero-v2-actions">
            <Link href="/chat" className="mk-btn mk-btn-primary">
              Start routing free
              <ArrowRight size={16} className="mk-btn-arrow" />
            </Link>
            <Link href="/pricing" className="mk-btn mk-btn-secondary">
              See pricing
            </Link>
          </div>

          {/* Reassurance line */}
          <p style={{ marginTop: 14, fontSize: 13, color: "var(--marketing-muted)" }}>
            No account required · Keys stay on your device · Token balance always visible
          </p>

          {/* Pricing clarity */}
          <p style={{ marginTop: 6, fontSize: 13, color: "var(--marketing-muted)" }}>
            Free forever with your own API keys ·{" "}
            <Link href="/pricing" style={{ color: "var(--marketing-accent-light)", textDecoration: "none" }}>
              Managed keys from $15/mo →
            </Link>
          </p>

          {/* Terminal */}
          <div className="hero-v2-terminal">
            <div className="hero-v2-terminal-bar">
              <span className="hero-v2-terminal-dot" style={{ background: "#ef4444" }} />
              <span className="hero-v2-terminal-dot" style={{ background: "#f59e0b" }} />
              <span className="hero-v2-terminal-dot" style={{ background: "#22c55e" }} />
              <span style={{ marginLeft: 8, fontSize: 11, color: "var(--marketing-muted)", fontFamily: "monospace" }}>zintus — terminal</span>
            </div>
            <div className="hero-v2-terminal-body">
              {/* Static install line */}
              <div>
                <span className="t-prompt">$ </span>
                <span className="t-cmd">{INSTALL_CMD}</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span className="t-ok">✓ built zintus@0.2.0 (beta)</span>
              </div>
              {/* Animated lines */}
              {TERMINAL_LINES.slice(0, visibleLines).map((line, i) => (
                <div key={i}>
                  {line.type === "prompt" ? (
                    <><span className="t-prompt">$ </span><span className="t-cmd">{line.text}</span></>
                  ) : line.type === "route" ? (
                    <span className="t-route">{line.text}</span>
                  ) : line.type === "ok" ? (
                    <span className="t-ok">{line.text}</span>
                  ) : (
                    <span className="t-muted">{line.text}</span>
                  )}
                </div>
              ))}
              {visibleLines < TERMINAL_LINES.length ? (
                <span className="t-prompt" style={{ animation: "none" }}>▋</span>
              ) : null}
            </div>
          </div>

          {/* Copy install */}
          <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            <span style={{ fontSize: 12, color: "var(--marketing-muted)" }}>build from source · npm publish coming soon:</span>
            <button
              type="button"
              onClick={() => void copyCmd()}
              className={`m-terminal-copy${copied ? " copied" : ""}`}
              aria-label="Copy install command"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              <code>{INSTALL_CMD}</code>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
