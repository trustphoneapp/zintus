const ROWS: Array<{ feature: string; zintus: string; openrouter: string; direct: string }> = [
  { feature: "Smart quota routing", zintus: "yes", openrouter: "no", direct: "no" },
  { feature: "Keys stored on device", zintus: "yes", openrouter: "no", direct: "yes" },
  { feature: "Real-time quota tracking", zintus: "yes", openrouter: "no", direct: "no" },
  { feature: "Auto provider switching", zintus: "yes", openrouter: "no", direct: "no" },
  { feature: "Token compression", zintus: "yes", openrouter: "no", direct: "no" },
  { feature: "Provider markup", zintus: "0%", openrouter: "5%", direct: "0%" },
  { feature: "Free tier access", zintus: "yes", openrouter: "partial", direct: "yes" },
  { feature: "CLI + Web + Mobile", zintus: "yes", openrouter: "web only", direct: "no" },
  { feature: "Offline fallback (Ollama)", zintus: "yes", openrouter: "no", direct: "no" },
  { feature: "Remote gateway control", zintus: "yes", openrouter: "no", direct: "no" },
];

function Cell({ value, highlight }: { value: string; highlight?: boolean }) {
  if (value === "yes") {
    return <span style={{ color: "#34d399", fontWeight: 600 }}>✓</span>;
  }
  if (value === "no") {
    return <span style={{ color: "#475569" }}>✕</span>;
  }
  return (
    <span style={{ color: highlight ? "#e9d5ff" : "#94a3b8", fontWeight: highlight ? 600 : 400 }}>
      {value}
    </span>
  );
}

export function Comparison() {
  return (
    <section id="why-zintus" style={{ padding: "5rem 0" }}>
      <div className="m-shell">
        <h2 style={{ fontSize: "2rem", fontWeight: 700, textAlign: "center", color: "#e9d5ff" }}>
          Why Zintus?
        </h2>
        <p
          style={{
            textAlign: "center",
            color: "#94a3b8",
            margin: "0.75rem auto 2.5rem",
            maxWidth: 560,
            fontSize: 15,
          }}
        >
          See how Zintus compares to using providers directly or routing through
          OpenRouter.
        </p>

        <div className="cmp-scroll">
          <table className="cmp-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Feature</th>
                <th className="cmp-col-zintus">Zintus</th>
                <th>OpenRouter</th>
                <th>Direct API</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.feature}>
                  <td style={{ textAlign: "left", color: "#cbd5e1" }}>{row.feature}</td>
                  <td className="cmp-col-zintus">
                    <Cell value={row.zintus} highlight />
                  </td>
                  <td>
                    <Cell value={row.openrouter} />
                  </td>
                  <td>
                    <Cell value={row.direct} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p style={{ textAlign: "center", color: "#4a3070", fontSize: 12, marginTop: "1.25rem" }}>
          Comparison based on public documentation as of June 2026.
        </p>
      </div>
    </section>
  );
}
