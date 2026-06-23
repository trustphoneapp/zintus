"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, Zap } from "lucide-react";

const INSTALL_CMD = "npm install -g zintus";

const TERMINAL_LINES = [
  { delay: 0,    type: "prompt", text: "zintus chat" },
  { delay: 600,  type: "route",  text: "→ routing across 12 providers..." },
  { delay: 1200, type: "ok",     text: "✓ cerebras/llama-3.3-70b  [42ms]" },
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
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="hero-v2">
      <div className="m-shell">
        <div className="hero-v2-inner">
          {/* Badge */}
          <div className="hero-v2-eyebrow">
            <span className="badge-pill">
              <Zap size={11} />
              12 free AI providers · zero markup
            </span>
          </div>

          {/* Headline */}
          <h1>
            The open AI router.<br />
            <em>Route smarter. Pay nothing.</em>
          </h1>

          {/* Subheadline */}
          <p className="hero-v2-sub">
            12 free AI providers in one chat. Zintus picks the fastest one with quota
            left — and switches automatically when one runs out. Your keys stay on
            your device. We never see them.
          </p>

          {/* CTAs */}
          <div className="hero-v2-actions">
            <Link href="/chat" className="hero-v2-btn-primary">
              Try it free
              <ArrowRight size={16} />
            </Link>
            <Link href="/docs" className="hero-v2-btn-secondary">
              Read the docs
            </Link>
          </div>

          {/* Reassurance line */}
          <p style={{ marginTop: 14, fontSize: 13, color: "var(--marketing-muted)" }}>
            No account required · Keys stay on your device · Start chatting instantly
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
              <span style={{ marginLeft: 8, fontSize: 11, color: "#4a3070", fontFamily: "monospace" }}>zintus — terminal</span>
            </div>
            <div className="hero-v2-terminal-body">
              {/* Static install line */}
              <div>
                <span className="t-prompt">$ </span>
                <span className="t-cmd">{INSTALL_CMD}</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span className="t-ok">✓ zintus@2.0.0 installed</span>
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
          <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#4a3070" }}>or install via npm:</span>
            <button
              type="button"
              onClick={() => void copyCmd()}
              style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(124,58,237,0.1)", border: "1px solid rgba(124,58,237,0.25)", borderRadius: 6, padding: "5px 12px", cursor: "pointer", color: "#c4b5fd", fontSize: 13, fontFamily: "monospace" }}
            >
              <code>{INSTALL_CMD}</code>
              {copied ? <Check size={13} color="#34d399" /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
