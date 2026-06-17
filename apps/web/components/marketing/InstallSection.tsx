"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { INSTALL_SNIPPETS, type InstallSnippetKey } from "./install-commands";
import { Reveal } from "./Reveal";

export function InstallSection() {
  const [tab, setTab] = useState<InstallSnippetKey>("repo");
  const [copied, setCopied] = useState(false);
  const tabs = Object.keys(INSTALL_SNIPPETS) as InstallSnippetKey[];
  const activeSnippet = INSTALL_SNIPPETS[tab];

  async function copySnippet() {
    await navigator.clipboard.writeText(activeSnippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="m-section" id="install">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">For developers</p>
          <h2 className="m-title">Run it yourself in under a minute</h2>
          <p className="m-subtitle">
            Clone the repo, install dependencies, then start the CLI, gateway, or web app.
            Not a developer? Use the web chat — no install needed.
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="m-terminal">
            <div className="m-terminal-header">
              <div className="m-terminal-tabs">
                {tabs.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={item === tab ? "active" : ""}
                    onClick={() => setTab(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="m-terminal-copy"
                aria-label="Copy command"
                onClick={() => void copySnippet()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre>
              <code>
                {activeSnippet
                  .split("\n")
                  .map((line) => `$ ${line}`)
                  .join("\n")}
              </code>
            </pre>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
