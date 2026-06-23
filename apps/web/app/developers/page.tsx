import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";

export const metadata = {
  title: "Developers — Zintus",
  description:
    "Drop-in OpenAI-compatible gateway. Point any OpenAI SDK at your local Zintus gateway to route across 12 free providers.",
};

const SNIPPETS: Array<{ label: string; code: string }> = [
  {
    label: "OpenAI SDK (Node)",
    code: `import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:8788/v1", // your local Zintus gateway
  apiKey: "any-string",                 // gateway uses your local keys
});

const res = await openai.chat.completions.create({
  model: "auto",                        // or a provider/model id
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});`,
  },
  {
    label: "Vercel AI SDK",
    code: `import { createOpenAI } from "@ai-sdk/openai";

const zintus = createOpenAI({
  baseURL: "http://localhost:8788/v1",
  apiKey: "any-string",
});

const { textStream } = streamText({
  model: zintus("auto"),
  prompt: "Explain routing in one line.",
});`,
  },
  {
    label: "Python",
    code: `from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8788/v1",
    api_key="any-string",
)

stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)`,
  },
];

const COMPATIBLE = [
  "OpenAI SDK",
  "Vercel AI SDK",
  "LangChain",
  "LlamaIndex",
  "Any OpenAI-compatible client",
];

export default function DevelopersPage() {
  return (
    <main className="marketing-page">
      <Navbar />

      <section className="m-section">
        <div className="m-shell">
          <p className="m-eyebrow">Developers</p>
          <h1 className="m-title">Drop-in for any OpenAI SDK</h1>
          <p className="m-subtitle">
            Run the Zintus gateway locally and change two lines in your existing
            code. Requests route across 12 free providers with automatic
            failover — your keys never leave your machine.
          </p>
          <div className="m-terminal" style={{ marginTop: "1.25rem" }}>
            <pre>
              <code>
                {"$ npm install -g zintus\n"}
                {"$ zintus serve   # starts the gateway on :8788"}
              </code>
            </pre>
          </div>
        </div>
      </section>

      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title">Two-line change</h2>
          <div className="dev-snippets">
            {SNIPPETS.map((snippet) => (
              <div key={snippet.label} className="dev-snippet">
                <div className="dev-snippet-label">{snippet.label}</div>
                <pre>
                  <code>{snippet.code}</code>
                </pre>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title">Works with</h2>
          <div className="dev-compat">
            {COMPATIBLE.map((name) => (
              <span key={name} className="dev-compat-chip">
                {name}
              </span>
            ))}
          </div>
          <p className="m-subtitle" style={{ marginTop: "1rem" }}>
            Full API reference lives in the{" "}
            <a href="/docs" className="auth-link">
              docs
            </a>
            .
          </p>
        </div>
      </section>

      <Footer />
    </main>
  );
}
