"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Check, Copy, Sparkles } from "lucide-react";
import { REPO_INSTALL_COMMAND } from "./install-commands";

export function Hero() {
  const [copied, setCopied] = useState(false);

  async function copyInstallCommand() {
    await navigator.clipboard.writeText(REPO_INSTALL_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="m-hero">
      <div className="m-shell">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="m-hero-inner"
        >
          <div className="m-hero-pill">
            <Sparkles size={14} />
            12 free AI models, one simple chat
          </div>
          <h1>Use the best free AIs, all from one place.</h1>
          <p>
            MultipleAI connects you to 12 free AI services at once. Ask a question and it
            automatically picks one that&apos;s fast and available. If one runs out, it
            switches to another — so you can keep chatting.
          </p>
          <div className="m-hero-actions">
            <Link href="/chat" className="m-primary-btn">
              Try it now
              <ArrowRight size={16} />
            </Link>
            <a href="#how-it-works" className="m-secondary-btn">
              See how it works
            </a>
          </div>
          <div className="m-hero-note">
            Free &amp; open source. Connect provider keys when you&apos;re ready.
          </div>
          <div className="m-command-strip">
            <span className="m-command-label">Developer?</span>
            <code>{REPO_INSTALL_COMMAND}</code>
            <button
              type="button"
              aria-label="Copy install command"
              onClick={() => void copyInstallCommand()}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
