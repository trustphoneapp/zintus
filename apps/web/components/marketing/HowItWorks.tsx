"use client";

import { Reveal } from "./Reveal";

const STEPS = [
  {
    number: "01",
    title: "Install the CLI",
    body: "One command. Works on macOS, Linux, Windows. Keys are stored in your OS keychain — never on our servers.",
    code: "$ npm install -g zintus\n$ zintus init",
    codeComment: "# walks you through adding free API keys",
  },
  {
    number: "02",
    title: "The router decides",
    body: "Checks quota across all providers in real time. Picks the fastest one with tokens remaining.",
    code: "$ zintus chat \"explain quantum computing\"",
    codeComment: "# → cerebras/llama-3.3-70b [38ms]",
  },
  {
    number: "03",
    title: "Automatic fallback",
    body: "If one provider hits its limit, Zintus instantly routes to the next. You never see an error.",
    code: "cerebras → groq → gemini → deepseek → ollama",
    codeComment: "# priority order, fully configurable",
  },
];

export function HowItWorks() {
  return (
    <section className="m-section" id="how-it-works">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">How it works</p>
          <h2 className="m-title" style={{ marginBottom: "3rem" }}>
            Smart routing in three steps.
          </h2>
        </Reveal>
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {STEPS.map((step, i) => (
            <Reveal key={step.number} delay={i * 0.1}>
              <div className="gradient-border-card">
                <div
                  className="gradient-border-inner"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "2rem",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <span
                      style={{
                        fontSize: "3rem",
                        fontWeight: 800,
                        color: "rgba(124,58,237,0.2)",
                        lineHeight: 1,
                        display: "block",
                        marginBottom: "0.75rem",
                      }}
                    >
                      {step.number}
                    </span>
                    <h3
                      style={{
                        fontSize: "1.2rem",
                        fontWeight: 700,
                        color: "#f1f5f9",
                        marginBottom: "0.75rem",
                      }}
                    >
                      {step.title}
                    </h3>
                    <p
                      style={{
                        fontSize: "0.9rem",
                        color: "#94a3b8",
                        lineHeight: 1.7,
                      }}
                    >
                      {step.body}
                    </p>
                  </div>
                  <div
                    style={{
                      background: "rgba(7,4,15,0.8)",
                      border: "1px solid rgba(124,58,237,0.2)",
                      borderRadius: 10,
                      padding: "1.1rem 1.3rem",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "0.82rem",
                      lineHeight: 1.8,
                    }}
                  >
                    {step.code.split("\n").map((line, j) => (
                      <div key={j}>
                        {line.startsWith("$") ? (
                          <>
                            <span style={{ color: "#7c3aed" }}>$ </span>
                            <span style={{ color: "#c4b5fd" }}>
                              {line.replace(/^\$\s*/, "")}
                            </span>
                          </>
                        ) : (
                          <span style={{ color: "#c4b5fd" }}>{line}</span>
                        )}
                      </div>
                    ))}
                    <div>
                      <span style={{ color: "#4a3070" }}>{step.codeComment}</span>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
