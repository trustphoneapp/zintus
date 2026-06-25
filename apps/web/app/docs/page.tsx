import type { Metadata } from "next";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";

export const metadata: Metadata = {
  title: "Docs — Zintus",
  description:
    "Quickstart, BYOK providers, the OpenAI-compatible gateway API, Docker self-hosting, cloud relay, and policy-based routing for Zintus.",
};

/* ─── source of truth: apps/cli/src/index.ts ───────────────── */
const CLI_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "zintus setup", description: "First-run wizard: add API keys with validation." },
  { command: 'zintus chat "<prompt>"', description: "Stream a chat response from the best available provider." },
  { command: 'zintus "<prompt>"', description: "Shorthand for chat." },
  { command: "zintus serve", description: "Run the gateway HTTP server the GUI clients connect to (127.0.0.1:8788)." },
  { command: "zintus status", description: "Live dashboard of providers and quota usage." },
  { command: "zintus keys set <provider> <key>", description: "Store an API key in the OS keychain." },
  { command: "zintus keys list", description: "List stored API keys (masked)." },
  { command: "zintus keys remove <provider>", description: "Remove a stored API key." },
  { command: "zintus config", description: "Configure routing strategy via interactive wizard." },
  { command: "zintus doctor", description: "Check health: keychain, quota DB, provider keys, Ollama, relay." },
  { command: "zintus history", description: "List saved conversation threads." },
  { command: "zintus trace [traceId]", description: "Show the routing-trace waterfall for the last or given request." },
  { command: "zintus cloud login", description: "Sign in to zintus.app and save credentials to ~/.zintus/cloud.json." },
  { command: "zintus cloud status", description: "Show cloud connection status." },
  { command: "zintus cloud logout", description: "Sign out and remove ~/.zintus/cloud.json." },
];

/* ─── source of truth: README.md + packages/types PROVIDER_IDS ─ */
const PROVIDERS: Array<{ name: string; id: string; note: string }> = [
  { name: "Cerebras", id: "cerebras", note: "Free tier · fast inference" },
  { name: "Groq", id: "groq", note: "Free tier · rolling-window cooldown from x-ratelimit headers" },
  { name: "Gemini", id: "gemini", note: "Google AI free tier" },
  { name: "OpenRouter", id: "openrouter", note: "Free :free models" },
  { name: "Cohere", id: "cohere", note: "Free trial tier" },
  { name: "Mistral", id: "mistral", note: "Free tier" },
  { name: "DeepSeek", id: "deepseek", note: "Bring your own key" },
  { name: "Fireworks AI", id: "fireworks", note: "Bring your own key" },
  { name: "xAI Grok", id: "xai", note: "Bring your own key" },
  { name: "Hugging Face", id: "huggingface", note: "Bring your own key" },
  { name: "LM Studio", id: "lmstudio", note: "Local · no API key · LM_STUDIO_HOST (default http://localhost:1234/v1)" },
  { name: "Ollama", id: "ollama", note: "Local · no API key · OLLAMA_HOST (default http://localhost:11434)" },
];

/* ─── source of truth: docs/openapi.yaml ───────────────────── */
const ENDPOINTS: Array<{ route: string; auth: string; desc: string }> = [
  { route: "POST /v1/chat/completions", auth: "Bearer", desc: "OpenAI-compatible chat completion (SSE stream by default, or stream: false)." },
  { route: "POST /v1/research", auth: "Bearer", desc: "Streaming deep research (decompose → search → synthesize). Needs TAVILY_API_KEY or SERPER_API_KEY." },
  { route: "GET /v1/status", auth: "Bearer", desc: "Provider inventory, key presence, cooldown, live quota, and savings." },
  { route: "GET /v1/savings", auth: "Bearer", desc: "Estimated USD a paid API would have charged for the free tokens served." },
  { route: "GET /v1/traces", auth: "Bearer", desc: "Recent routing traces (also /v1/traces/last and /v1/traces/{id})." },
  { route: "GET /health", auth: "Public", desc: "Minimal liveness probe; 503 while draining. No topology or savings leaked." },
];

/* ─── source of truth: docs/DEPLOY.md ──────────────────────── */
const ENV_VARS: Array<{ name: string; def: string; why: string }> = [
  { name: "GATEWAY_TOKEN", def: "—", why: "Required for any non-loopback bind. Bearer token for all routes except /health. Generate with openssl rand -hex 24." },
  { name: "GATEWAY_HOST / GATEWAY_PORT", def: "127.0.0.1 / 8788", why: "Set GATEWAY_HOST=0.0.0.0 only when you intend to expose it; prefer a TLS-terminating reverse proxy." },
  { name: "GATEWAY_RATELIMIT_RPM", def: "off", why: "Per-client request cap on /v1/chat/completions and /v1/research (429 + Retry-After). Set it on any exposed deployment." },
  { name: "GATEWAY_TRUST_PROXY", def: "unset", why: "Only when set is X-Forwarded-For trusted for rate-limit/IP keying. Leave unset unless behind a trusted proxy." },
  { name: "GATEWAY_CORS_ORIGIN", def: "unset", why: "Restrict to your web origin(s) if browsers call the gateway directly. No wildcard with credentials." },
  { name: "GATEWAY_REQUEST_TIMEOUT_MS", def: "60000", why: "Connect / first-token timeout; aborts upstream and releases the quota reservation (408)." },
  { name: "GATEWAY_STREAM_IDLE_TIMEOUT_MS", def: "60000", why: "Mid-stream idle watchdog; aborts a stalled provider. 0 disables." },
  { name: "GATEWAY_DRAIN_TIMEOUT_MS", def: "—", why: "Graceful-shutdown bound: on SIGTERM/SIGINT /health flips to 503 draining, in-flight streams finish, then exit." },
  { name: "GATEWAY_MAX_BODY_BYTES / GATEWAY_MAX_MESSAGES", def: "—", why: "Bound request size / message count to limit abuse (413)." },
];

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: "quickstart", label: "Quickstart" },
  { id: "byok", label: "BYOK & providers" },
  { id: "gateway", label: "Gateway & API" },
  { id: "self-host", label: "Self-host (Docker)" },
  { id: "cloud", label: "Cloud relay" },
  { id: "policy", label: "Routing & policy" },
  { id: "cli", label: "CLI reference" },
  { id: "license", label: "License" },
];

const SPEC_URL = "https://github.com/trustphoneapp/zintus/blob/main/docs/openapi.yaml";

const cardItem: React.CSSProperties = { padding: "1rem 1.05rem" };
const cardLabel: React.CSSProperties = { fontWeight: 600, color: "var(--marketing-text)" };
const codeStrong: React.CSSProperties = { color: "var(--marketing-text)", fontWeight: 600 };

function Terminal({ children }: { children: string }) {
  return (
    <div className="m-terminal" style={{ marginTop: "1rem" }}>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

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
            Zintus is a local-first, BYOK router that maximizes free-tier quotas across 12 AI
            providers from one OpenAI-compatible endpoint — with automatic same-model failover,
            cooldown, and quota-aware routing. Your keys live in your OS keychain (CLI/desktop) or
            your browser (web). There is no SaaS bill and no hosted control plane.
          </p>

          {/* On this page */}
          <nav
            aria-label="On this page"
            style={{
              marginTop: "1.5rem",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem 1rem",
            }}
          >
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                style={{ color: "var(--marketing-accent-light)", fontSize: "0.9rem" }}
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      {/* Quickstart */}
      <section className="m-section" id="quickstart" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">Quickstart</h2>
          <p className="m-subtitle">
            Install the CLI, run the first-run wizard to add a free provider key, then chat.
          </p>
          <Terminal>{`$ npm install -g zintus
$ zintus setup                       # add + validate free provider keys
$ zintus chat "Hello from Zintus"`}</Terminal>

          <div className="m-faq" style={{ marginTop: "1.5rem" }}>
            <div className="m-faq-item" style={cardItem}>
              <p style={cardLabel}>1. Install</p>
              <p style={{ marginTop: "0.4rem" }}>
                One command installs the CLI globally via npm. Requires Node/npm;{" "}
                <a href="https://bun.sh" style={{ color: "var(--marketing-accent-light)" }}>
                  Bun
                </a>{" "}
                1.2+ is recommended if you build from source.
              </p>
            </div>
            <div className="m-faq-item" style={cardItem}>
              <p style={cardLabel}>2. Add a key</p>
              <p style={{ marginTop: "0.4rem" }}>
                <code>zintus setup</code> walks you through adding free API keys (Cerebras, Groq,
                Gemini, and more) and validates each one. Prefer doing it by hand? Use{" "}
                <code>zintus keys set &lt;provider&gt; &lt;key&gt;</code>. Keys are stored in your OS
                keychain — never sent to any Zintus server.
              </p>
            </div>
            <div className="m-faq-item" style={cardItem}>
              <p style={cardLabel}>3. Chat</p>
              <p style={{ marginTop: "0.4rem" }}>
                <code>zintus chat &quot;…&quot;</code> streams a response from the best available
                provider. When one runs out of quota or rate-limits, the router automatically fails
                over to the next. Run <code>zintus serve</code> to expose the gateway for the web,
                desktop, and mobile clients.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* BYOK & providers */}
      <section className="m-section" id="byok" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">BYOK &amp; providers</h2>
          <p className="m-subtitle">
            BYOK (Bring Your Own Key) is zero-knowledge: you sign up for free-tier keys and store
            them locally. The CLI and desktop app keep keys in your OS keychain (via{" "}
            <code>@napi-rs/keyring</code>); the web app encrypts them in your browser with Web Crypto
            (AES-256-GCM + PBKDF2) before <code>localStorage</code>; mobile uses SecureStore. Keys
            never reach a Zintus server. Use the <code>id</code> below with{" "}
            <code>zintus keys set &lt;id&gt; &lt;key&gt;</code>.
          </p>
          <div className="m-faq">
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                className="m-faq-item"
                style={{
                  padding: "0.85rem 1.05rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "1rem",
                  flexWrap: "wrap",
                }}
              >
                <span style={cardLabel}>
                  {p.name}{" "}
                  <code style={{ fontWeight: 400, opacity: 0.7 }}>{p.id}</code>
                </span>
                <span style={{ opacity: 0.65 }}>{p.note}</span>
              </div>
            ))}
          </div>
          <p className="m-subtitle" style={{ marginTop: "1rem", fontSize: "0.85rem", opacity: 0.7 }}>
            LM Studio and Ollama run on your machine and need no API key. Free-tier limits are set by
            each provider and change over time; check the provider for current quotas.
          </p>
        </div>
      </section>

      {/* Gateway & API */}
      <section className="m-section" id="gateway" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">Gateway &amp; API</h2>
          <p className="m-subtitle">
            The gateway is the single stateful brain the GUI clients connect to. It exposes an
            OpenAI-compatible endpoint, so you can point any OpenAI SDK at it by setting{" "}
            <code>base_url</code> to the gateway. Zintus routes to its own provider fleet — OpenAI is
            not a backend provider.
          </p>
          <Terminal>{`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8788/v1",
    api_key="$GATEWAY_TOKEN",          # your gateway token (or any value if unset)
)

stream = client.chat.completions.create(
    model="llama-3.3-70b",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`}</Terminal>
          <p className="m-subtitle" style={{ marginTop: "1rem" }}>
            Responses carry routing-metadata headers: <code>X-Provider-Used</code>,{" "}
            <code>X-Cache-Hit</code> (<code>L1</code>/<code>L2</code>/<code>miss</code>), and{" "}
            <code>X-Failover-Count</code>. Deviations from OpenAI: no <code>created</code>/
            <code>usage</code> fields; <code>id</code> is the internal routing trace id.
          </p>

          <h3 className="m-eyebrow" style={{ marginTop: "1.75rem" }} id="api-reference">
            API reference
          </h3>
          <div className="m-faq" style={{ marginTop: "0.75rem" }}>
            {ENDPOINTS.map((e) => (
              <div key={e.route} className="m-faq-item" style={cardItem}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                  <code style={codeStrong}>{e.route}</code>
                  <span style={{ opacity: 0.55, fontSize: "0.8rem", whiteSpace: "nowrap" }}>{e.auth}</span>
                </div>
                <p style={{ marginTop: "0.4rem" }}>{e.desc}</p>
              </div>
            ))}
          </div>
          <p className="m-subtitle" style={{ marginTop: "1rem" }}>
            Full request/response schemas live in the OpenAPI 3.1 spec:{" "}
            <a href={SPEC_URL} style={{ color: "var(--marketing-accent-light)" }}>
              docs/openapi.yaml
            </a>
            . When <code>GATEWAY_TOKEN</code> is set, every endpoint except <code>GET /health</code>{" "}
            requires <code>Authorization: Bearer &lt;token&gt;</code>; <code>/metrics</code> is also
            available (Prometheus text or JSON), auth-gated only when a token is configured.
          </p>
        </div>
      </section>

      {/* Self-host (Docker) */}
      <section className="m-section" id="self-host" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">Self-host (Docker)</h2>
          <p className="m-subtitle">
            One command, no SaaS — the gateway runs locally and your keys stay on the host. Keys and{" "}
            <code>quota.db</code> persist in the <code>zintus-data</code> named volume; the container
            runs as the non-root <code>bun</code> user (uid 1000).
          </p>
          <Terminal>{`# 1. Routing policy (no secrets in it):
cp policy.example.json policy.json

# 2. Bring up the gateway on :8788 with a strong token:
GATEWAY_TOKEN=$(openssl rand -hex 24) docker compose up -d

# 3. Verify (minimal, unauthenticated liveness):
curl -s localhost:8788/health | jq        # { "ok": true }

# 4. Auth-gated status + savings:
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" localhost:8788/v1/status | jq`}</Terminal>
          <p className="m-subtitle" style={{ marginTop: "1rem" }}>
            Prebuilt images publish to GHCR on each <code>v*</code> tag (
            <code>ghcr.io/&lt;owner&gt;/zintus-gateway</code>). A bind-mounted state dir must be
            writable by uid 1000 (<code>chown 1000:1000</code>), or use the named volume. Point any
            OpenAI-compatible client at <code>http://localhost:8788/v1</code> with the bearer token.
          </p>

          <h3 className="m-eyebrow" style={{ marginTop: "1.75rem" }}>
            Network-exposed checklist
          </h3>
          <p className="m-subtitle" style={{ marginTop: "0.5rem" }}>
            The gateway binds <code>127.0.0.1</code> by default and refuses to bind a public
            interface without <code>GATEWAY_TOKEN</code>. Anyone who can reach the gateway and
            present the token can spend every provider key on the host — scope both accordingly.
          </p>
          <div className="m-faq" style={{ marginTop: "0.75rem" }}>
            {ENV_VARS.map((v) => (
              <div key={v.name} className="m-faq-item" style={cardItem}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                  <code style={codeStrong}>{v.name}</code>
                  <span style={{ opacity: 0.55, fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                    default: {v.def}
                  </span>
                </div>
                <p style={{ marginTop: "0.4rem" }}>{v.why}</p>
              </div>
            ))}
          </div>
          <p className="m-subtitle" style={{ marginTop: "1rem", fontSize: "0.85rem", opacity: 0.7 }}>
            Always terminate TLS at a reverse proxy (Caddy/nginx/Cloudflare); the gateway speaks
            plain HTTP. Give your orchestrator a grace period ≥ <code>GATEWAY_DRAIN_TIMEOUT_MS</code>.
          </p>
        </div>
      </section>

      {/* Cloud relay */}
      <section className="m-section" id="cloud" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">Cloud relay (optional)</h2>
          <p className="m-subtitle">
            Zintus Cloud lets you reach your home gateway from the mobile app (or{" "}
            <code>zintus.app/dashboard</code>) without re-scanning a QR code on every restart. It is
            still BYOK — your keys never leave the home machine. The relay is outbound-only: the home
            machine initiates the connection, so it works behind NAT and firewalls with no inbound
            ports. Only status JSON, control commands, and SSE events pass through; never API keys,
            raw chat messages, or router state.
          </p>
          <Terminal>{`$ zintus cloud login          # sign in to zintus.app, save credentials
$ zintus serve --cloud        # start gateway + connect to the relay
# then open zintus.app/dashboard — your gateway appears online`}</Terminal>
          <p className="m-subtitle" style={{ marginTop: "1rem" }}>
            Managed-key tiers (where Zintus holds the provider keys for you) are{" "}
            <strong>coming soon</strong> — the key-custody backend is not yet built, so those paid
            tiers are not purchasable today. The free, BYOK path above is fully functional.
          </p>
        </div>
      </section>

      {/* Routing & policy */}
      <section className="m-section" id="policy" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">Routing &amp; policy</h2>
          <p className="m-subtitle">
            Provider priority, weights, model groups, fallbacks, and per-provider quota limits live
            in a single <code>policy.json</code> (repo root, <code>~/.zintus/policy.json</code>, or{" "}
            <code>$ZINTUS_POLICY</code>). The gateway loads it at startup and{" "}
            <strong>hot-reloads on change</strong> — no restart needed. Every field is optional;
            missing fields fall back to built-in defaults. No secrets belong in this file.
          </p>
          <Terminal>{`{
  "providerPriority": ["cerebras", "groq", "gemini", "fireworks", "openrouter"],
  "providerWeights": { "groq": 7, "cerebras": 3 },
  "modelGroups": { "llama-3.3-70b": ["groq", "openrouter", "fireworks"] },
  "fallbacks": { "on_429": "next_provider", "on_5xx": "next_provider" },
  "limits": {
    "groq": { "requestsPerDay": 1000, "tokensPerDay": 100000, "requestsPerMinute": 30 },
    "gemini": { "requestsPerDay": 1500, "requestsPerMinute": 15 }
  }
}`}</Terminal>
          <p className="m-subtitle" style={{ marginTop: "1rem" }}>
            Start from <code>policy.example.json</code> (no secrets in it):{" "}
            <code>cp policy.example.json ~/.zintus/policy.json</code>, edit, and save — the running
            gateway picks it up. In Docker, mount it read-only:{" "}
            <code>-v &quot;$PWD/policy.json:/app/policy.json:ro&quot;</code>. You can also override
            routing per request via the <code>strategy</code>, <code>provider_weights</code>, and{" "}
            <code>virtual_key</code> fields on <code>/v1/chat/completions</code>.
          </p>
        </div>
      </section>

      {/* CLI reference */}
      <section className="m-section" id="cli" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">CLI reference</h2>
          <div className="m-faq" style={{ marginTop: "1rem" }}>
            {CLI_COMMANDS.map((item) => (
              <div key={item.command} className="m-faq-item" style={cardItem}>
                <code style={codeStrong}>{item.command}</code>
                <p style={{ marginTop: "0.4rem" }}>{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* License */}
      <section className="m-section" id="license" style={{ scrollMarginTop: "5rem" }}>
        <div className="m-shell">
          <h2 className="m-title">License</h2>
          <p className="m-subtitle">
            Zintus is source-available under the Business Source License 1.1 — free for personal and
            internal business use. Contact YS Ventures LLC for commercial licensing.
          </p>
        </div>
      </section>

      <Footer />
    </main>
  );
}
