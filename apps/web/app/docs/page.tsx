import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";

const CLI_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "zintus init", description: "First-run wizard: add API keys with validation." },
  { command: "zintus chat <prompt>", description: "Stream a chat response from the best available provider." },
  { command: "zintus serve", description: "Run the gateway HTTP server the GUI clients connect to." },
  { command: "zintus status", description: "Live dashboard of providers and quota usage." },
  { command: "zintus keys set <provider> <key>", description: "Store an API key in the OS keychain." },
  { command: "zintus keys list", description: "List all configured providers." },
  { command: "zintus config", description: "Configure routing strategy via interactive wizard." },
  { command: "zintus doctor", description: "Check system health: keychain, quota DB, providers, Ollama, relay." },
  { command: "zintus cloud login", description: "Link this machine to your Zintus Cloud account." },
  { command: "zintus cloud status", description: "Show relay connection status." },
  { command: "zintus cloud logout", description: "Disconnect from Zintus Cloud." },
];

const PROVIDERS: Array<{ name: string; limit: string }> = [
  { name: "Cerebras", limit: "1M tokens/day" },
  { name: "Groq (70B)", limit: "1,000 req/day" },
  { name: "Groq (8B)", limit: "14,400 req/day" },
  { name: "Gemini Flash", limit: "1,500 req/day" },
  { name: "OpenRouter :free", limit: "50–1,000 req/day" },
  { name: "Cohere", limit: "1,000 calls/month" },
  { name: "Mistral", limit: "~1B tokens/month" },
  { name: "Ollama local", limit: "Unlimited (runs on your machine)" },
];

export default function DocsPage() {
  return (
    <main className="marketing-page">
      <Navbar />

      {/* Hero */}
      <section className="m-section">
        <div className="m-shell">
          <p className="m-eyebrow">Documentation</p>
          <h1 className="m-title">Docs</h1>
          <p className="m-subtitle">
            Zintus is a CLI and gateway that routes chat requests across multiple free AI
            providers, switching automatically when one runs out of quota.
          </p>
        </div>
      </section>

      {/* Quick start */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title">Quick start</h2>
          <div className="m-terminal">
            <pre>
              <code>
                {"$ npm install -g zintus\n"}
                {"$ zintus init\n"}
                {"$ zintus chat"}
              </code>
            </pre>
          </div>

          <div className="m-faq" style={{ marginTop: "1.5rem" }}>
            <div className="m-faq-item" style={{ padding: "1rem 1.05rem" }}>
              <p style={{ fontWeight: 600, color: "var(--marketing-text)" }}>
                1. Install
              </p>
              <p style={{ marginTop: "0.4rem" }}>
                One command installs the CLI globally via npm.
              </p>
            </div>
            <div className="m-faq-item" style={{ padding: "1rem 1.05rem" }}>
              <p style={{ fontWeight: 600, color: "var(--marketing-text)" }}>
                2. Init
              </p>
              <p style={{ marginTop: "0.4rem" }}>
                <code>zintus init</code> walks you through adding free API keys (Cerebras, Groq,
                Gemini, etc.). Keys are stored in your OS keychain — never sent to any Zintus
                server.
              </p>
            </div>
            <div className="m-faq-item" style={{ padding: "1rem 1.05rem" }}>
              <p style={{ fontWeight: 600, color: "var(--marketing-text)" }}>
                3. Chat
              </p>
              <p style={{ marginTop: "0.4rem" }}>
                <code>zintus chat</code> streams a response from the best available provider.
                When one runs out of quota, it automatically falls back to the next.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CLI reference */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title">CLI reference</h2>
          <div className="m-faq" style={{ marginTop: "1rem" }}>
            {CLI_COMMANDS.map((item) => (
              <div key={item.command} className="m-faq-item" style={{ padding: "1rem 1.05rem" }}>
                <code style={{ color: "var(--marketing-text)", fontWeight: 600 }}>{item.command}</code>
                <p style={{ marginTop: "0.4rem" }}>{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Providers */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title">Free providers</h2>
          <p className="m-subtitle" style={{ marginBottom: "1.5rem" }}>
            Zintus works out of the box with these free-tier providers. Add as many keys as you
            like — the router picks the one with available quota.
          </p>
          <div className="m-faq">
            {PROVIDERS.map((p) => (
              <div
                key={p.name}
                className="m-faq-item"
                style={{
                  padding: "0.85rem 1.05rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "1rem",
                }}
              >
                <span style={{ fontWeight: 600, color: "var(--marketing-text)" }}>{p.name}</span>
                <span style={{ opacity: 0.65, whiteSpace: "nowrap" }}>{p.limit}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* License */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title">License</h2>
          <p className="m-subtitle">
            Zintus is source-available under the Business Source License 1.1.
          </p>
        </div>
      </section>

      <Footer />
    </main>
  );
}
