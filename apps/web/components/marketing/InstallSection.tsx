"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { INSTALL_STEPS } from "./install-commands";
import { Reveal } from "./Reveal";

const COPY_TEXT = INSTALL_STEPS.join("\n");

export function InstallSection() {
  const [copied, setCopied] = useState(false);

  async function copySteps() {
    await navigator.clipboard.writeText(COPY_TEXT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="m-section" id="install">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">For developers</p>
          <h2 className="m-title">Up in 60 seconds</h2>
          <p className="m-subtitle">
            Build the CLI from source with Bun (npm publish coming soon). Keys are
            stored in your OS keychain — never sent anywhere.
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="m-terminal">
            <div className="m-terminal-header">
              <span
                style={{
                  fontSize: 11,
                  color: "var(--marketing-muted)",
                  letterSpacing: "0.05em",
                }}
              >
                TERMINAL
              </span>
              <button
                type="button"
                className={`m-terminal-copy${copied ? " copied" : ""}`}
                aria-label="Copy all commands"
                onClick={() => void copySteps()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre>
              <code
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "0.9rem",
                  display: "block",
                }}
              >
                {INSTALL_STEPS.map((step, i) => (
                  <div key={i}>
                    <span style={{ color: "var(--marketing-accent)" }}>$ </span>
                    <span style={{ color: "var(--marketing-text)" }}>{step}</span>
                  </div>
                ))}
              </code>
            </pre>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
