// Server Component: static three-step markup wrapped in <Reveal> client islands.
import { Reveal } from "./Reveal";

const STEPS = [
  {
    number: "01",
    title: "Add your keys",
    body: "Drop in your API keys. They're stored in your OS keychain — never sent to our servers. Add one provider or twelve. Each one multiplies your free daily quota.",
    code: "$ zintus keys add\n$ zintus keys list",
    codeComment: "# stored in your OS keychain",
  },
  {
    number: "02",
    title: "The router decides",
    body: "Zintus checks quota across all providers in real time. Short prompt? Routes to the fastest model. Long context? Picks the one with a 2M token window. Code heavy? Goes to the best coder at T0 price.",
    code: "$ zintus chat \"summarize this contract\"",
    codeComment: "# → widest-context model · 2M tokens",
  },
  {
    number: "03",
    title: "See exactly what it cost",
    body: "Every response shows the model used, tokens consumed, and dollar cost. Your monthly balance updates in real time. No surprises at the end of the month.",
    code: "model: fast model · tokens: 1,247\ncost: $0.004 · balance updated",
    codeComment: "# shown after every response",
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
                        color: "var(--marketing-muted)",
                        opacity: 0.3,
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
                        color: "var(--marketing-text)",
                        marginBottom: "0.75rem",
                      }}
                    >
                      {step.title}
                    </h3>
                    <p
                      style={{
                        fontSize: "0.9rem",
                        color: "var(--marketing-muted)",
                        lineHeight: 1.7,
                      }}
                    >
                      {step.body}
                    </p>
                  </div>
                  <div
                    style={{
                      background: "var(--marketing-bg)",
                      border: "1px solid var(--marketing-border)",
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
                            <span style={{ color: "var(--marketing-accent)" }}>$ </span>
                            <span style={{ color: "var(--marketing-text)" }}>
                              {line.replace(/^\$\s*/, "")}
                            </span>
                          </>
                        ) : (
                          <span style={{ color: "var(--marketing-text)" }}>{line}</span>
                        )}
                      </div>
                    ))}
                    <div>
                      <span style={{ color: "var(--marketing-muted)" }}>{step.codeComment}</span>
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
