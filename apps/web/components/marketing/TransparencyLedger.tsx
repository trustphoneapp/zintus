import { Reveal } from "./Reveal";

// Illustrative demo data — this is a marketing page, not a live receipt feed.
interface LedgerRow {
  time: string;
  model: string;
  sub: string;
  fallback?: boolean;
  provider: string;
  tokens: string;
  latency: string;
  cost: string;
  ok: boolean;
}

const ROWS: LedgerRow[] = [
  { time: "09:42:01", model: "gemini-2.0-flash", sub: "Edge optimized", provider: "Google", tokens: "1,203", latency: "240ms", cost: "$0.0004", ok: true },
  { time: "09:41:56", model: "deepseek-v3", sub: "Fallback triggered", fallback: true, provider: "DeepSeek", tokens: "2,847", latency: "180ms", cost: "$0.0009", ok: false },
  { time: "09:41:48", model: "llama-3.3-70b", sub: "Cheap route enabled", provider: "Cerebras", tokens: "640", latency: "95ms", cost: "$0.0001", ok: true },
  { time: "09:41:33", model: "claude-haiku", sub: "Direct ingress", provider: "Anthropic", tokens: "892", latency: "310ms", cost: "$0.0007", ok: true },
  { time: "09:41:12", model: "qwen-2.5-72b", sub: "Cheap route enabled", provider: "Groq", tokens: "1,540", latency: "88ms", cost: "$0.0003", ok: true },
];

const SPEND = [
  { name: "Cerebras", pct: 42, top: true },
  { name: "Groq", pct: 27, top: false },
  { name: "Google", pct: 19, top: false },
  { name: "DeepSeek", pct: 12, top: false },
];

// 7 latency buckets; the modal bucket (50–100ms) is tallest and accent-tinted.
const LATENCY = [
  { label: "<50", h: 28 },
  { label: "50–100", h: 96, tall: true },
  { label: "100–150", h: 70 },
  { label: "150–200", h: 54 },
  { label: "200–300", h: 42 },
  { label: "300–500", h: 26 },
  { label: "500+", h: 14 },
];

export function TransparencyLedger() {
  return (
    <section className="m-band m-section m-cv" id="transparency">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Transparency</p>
          <h2 className="m-title" style={{ marginBottom: "2.4rem" }}>
            Every route. Every token. Receipted.
          </h2>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="mk-card ledger-card">
            <div className="ledger-head">
              <span className="ledger-head-title">Routing log</span>
              <span className="ledger-sample-tag">Illustrative sample</span>
            </div>
            <div className="ledger-scroll">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Model route</th>
                    <th>Provider</th>
                    <th className="ledger-num">Tokens</th>
                    <th className="ledger-num">Latency</th>
                    <th className="ledger-num">Cost</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((r) => (
                    <tr key={r.time}>
                      <td>{r.time}</td>
                      <td>
                        {r.model}
                        <span className={`ledger-sub${r.fallback ? " is-fallback" : ""}`}>
                          {r.sub}
                        </span>
                      </td>
                      <td>
                        <span className="ledger-chip">{r.provider}</span>
                      </td>
                      <td className="ledger-num">{r.tokens}</td>
                      <td className="ledger-num">{r.latency}</td>
                      <td className="ledger-num">{r.cost}</td>
                      <td>
                        <span
                          className={`ledger-status${r.ok ? "" : " is-hollow"}`}
                          aria-label={r.ok ? "ok" : "fallback"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ≤720px reflow variant (V8 12.5): the same rows as compact cards.
                Each metric is a real <dl> pair so semantics survive without ARIA
                role surgery. CSS shows this OR the table, never both. */}
            <div className="ledger-cards">
              {ROWS.map((r) => (
                <div className="ledger-rowcard" key={r.time}>
                  <div className="ledger-rowcard-head">
                    <div>
                      <div className="ledger-rowcard-model">{r.model}</div>
                      <span className={`ledger-sub${r.fallback ? " is-fallback" : ""}`}>
                        {r.sub}
                      </span>
                    </div>
                    <div className="ledger-rowcard-side">
                      <span className="ledger-chip">{r.provider}</span>
                      <span
                        className={`ledger-status${r.ok ? "" : " is-hollow"}`}
                        aria-label={r.ok ? "ok" : "fallback"}
                      />
                    </div>
                  </div>
                  <dl className="ledger-rowcard-grid">
                    <div>
                      <dt>Time</dt>
                      <dd>{r.time}</dd>
                    </div>
                    <div>
                      <dt>Tokens</dt>
                      <dd>{r.tokens}</dd>
                    </div>
                    <div>
                      <dt>Latency</dt>
                      <dd>{r.latency}</dd>
                    </div>
                    <div>
                      <dt>Cost</dt>
                      <dd>{r.cost}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <div className="ledger-panels">
          <Reveal delay={0.05}>
            <div className="mk-card ledger-panel">
              <p className="ledger-panel-title">Provider spend share</p>
              {SPEND.map((s) => (
                <div key={s.name} className="spend-row">
                  <span className="spend-name">{s.name}</span>
                  <span className="spend-track">
                    <span
                      className={`spend-fill${s.top ? " is-top" : ""}`}
                      style={{ width: `${s.pct}%` }}
                    />
                  </span>
                  <span className="spend-pct">{s.pct}%</span>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="mk-card ledger-panel">
              <p className="ledger-panel-title">Requests by latency</p>
              <div className="hist">
                {LATENCY.map((b) => (
                  <div key={b.label} className="hist-col">
                    <span
                      className={`hist-bar${b.tall ? " is-tall" : ""}`}
                      style={{ height: `${b.h}%` }}
                    />
                    <span className="hist-label">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
