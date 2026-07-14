"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, Zap } from "lucide-react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";
import { useMagnetic } from "./use-magnetic";

// The CLI is not yet published to a registry, so `npm i -g zintus` / `bun add -g`
// would 404. The honest, working path today is build-from-source with Bun (the
// CLI uses bun:sqlite). Keep this truthful until the package is actually live.
const INSTALL_CMD = "bun install && bun run --filter zintus build";

// Each scenario is typed char-by-char, line-by-line, then held 3s before the
// next one loops in. prompt → routed-provider → latency.
type Seg = { cls: string; text: string };
const SCENARIOS: Seg[][] = [
  [
    { cls: "t-prompt", text: "$ zintus chat \"summarize this contract\"" },
    { cls: "t-route", text: "→ routed: gemini-2.0-flash · edge optimized" },
    { cls: "t-ok", text: "✓ 240ms · 1,203 tokens" },
    { cls: "t-muted", text: "remaining balance: 4,998,727 tokens" },
  ],
  [
    { cls: "t-prompt", text: "$ zintus chat \"write a SQL migration\"" },
    { cls: "t-route", text: "→ fallback triggered → deepseek-v3 · code" },
    { cls: "t-ok", text: "✓ 180ms · 2,847 tokens" },
    { cls: "t-muted", text: "remaining balance: 4,995,880 tokens" },
  ],
  [
    { cls: "t-prompt", text: "$ zintus chat \"explain this stack trace\"" },
    { cls: "t-route", text: "→ routed: llama-3.3-70b · cheap route enabled" },
    { cls: "t-ok", text: "✓ 95ms · 640 tokens" },
    { cls: "t-muted", text: "remaining balance: 4,995,240 tokens" },
  ],
];

const CHAR_MS = 26;
const LINE_PAUSE_MS = 260;
const HOLD_MS = 3000;

function HeroTerminal() {
  const reduced = usePrefersReducedMotion();
  const [scenario, setScenario] = useState(0);
  const [line, setLine] = useState(0);
  const [char, setChar] = useState(0);

  useEffect(() => {
    if (reduced) return; // static first frame
    const lines = SCENARIOS[scenario]!;
    let t: number;
    if (line >= lines.length) {
      // All lines typed — hold, then advance to the next scenario.
      t = window.setTimeout(() => {
        setScenario((s) => (s + 1) % SCENARIOS.length);
        setLine(0);
        setChar(0);
      }, HOLD_MS);
    } else if (char < lines[line]!.text.length) {
      t = window.setTimeout(() => setChar((c) => c + 1), CHAR_MS);
    } else {
      t = window.setTimeout(() => {
        setLine((l) => l + 1);
        setChar(0);
      }, LINE_PAUSE_MS);
    }
    return () => window.clearTimeout(t);
  }, [reduced, scenario, line, char]);

  const lines = SCENARIOS[scenario]!;
  // Under reduced motion, show the first scenario fully as a static frame.
  const doneLines = reduced ? lines.length : line;
  const caretActive = !reduced && line < lines.length;

  return (
    <div className="hero-v2-terminal mk-card">
      <div className="hero-v2-terminal-bar">
        <span className="hero-v2-terminal-dot" style={{ background: "#ef4444" }} />
        <span className="hero-v2-terminal-dot" style={{ background: "#f59e0b" }} />
        <span className="hero-v2-terminal-dot" style={{ background: "#22c55e" }} />
        <span style={{ marginLeft: 8, fontSize: 11, color: "var(--marketing-muted)", fontFamily: "monospace" }}>
          zintus — terminal
        </span>
      </div>
      <div className="hero-v2-terminal-body" aria-hidden>
        {lines.map((seg, i) => {
          if (i > doneLines) return <div key={i} className="hero-v2-terminal-row">&nbsp;</div>;
          const text = reduced || i < doneLines ? seg.text : seg.text.slice(0, char);
          const isCaretLine = caretActive && i === doneLines;
          return (
            <div key={i} className="hero-v2-terminal-row">
              <span className={seg.cls}>{text || " "}</span>
              {isCaretLine ? <span className="hero-v2-caret" /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Hero() {
  const [copied, setCopied] = useState(false);
  const magnetic = useMagnetic<HTMLSpanElement>(4);

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
            The AI router that tells you <em>exactly what you bought.</em>
          </h1>

          {/* Subheadline — the accent lives here, in two inline words. */}
          <p className="hero-v2-sub">
            Most AI subscriptions hide their limits behind rolling windows, compute
            credits, and message caps. Zintus gives you <em>a number</em>. It
            doesn&apos;t change.
          </p>

          {/* CTAs */}
          <div className="hero-v2-actions">
            <span ref={magnetic} className="mk-magnetic mk-beam mk-beam-btn">
              <Link href="/chat" className="mk-btn mk-btn-primary">
                Start routing free
                <ArrowRight size={16} className="mk-btn-arrow" />
              </Link>
            </span>
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

          {/* Terminal — live typing loop */}
          <HeroTerminal />

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
