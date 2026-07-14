import type { CSSProperties, ReactNode } from "react";

// Static help page — no hooks, no gateway reads, so a plain server component.
// Every link below points at a route or anchor that actually exists in this app:
//   /docs, /docs#self-host, /providers, /settings/mcp, /privacy.

export const metadata = {
  title: "Help & docs · Zintus",
  description:
    "Get Zintus running: gateway troubleshooting, bring-your-own-key setup, MCP servers, and privacy.",
};


const sectionHeadStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "0 2px",
  marginTop: 8,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--color-text-muted)",
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={sectionHeadStyle}>
        <span style={sectionTitleStyle}>{title}</span>
        {description ? <span className="muted">{description}</span> : null}
      </div>
      {children}
    </section>
  );
}

// Small line icons (no extra deps) so topic cards read like the mockup.
function Icon({ d }: { d: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {d}
    </svg>
  );
}

type Topic = {
  title: string;
  desc: string;
  href: string;
  hue: number;
  icon: ReactNode;
};

// Honest, real topics. No billing/top-up — those don't exist here.
const TOPICS: Topic[] = [
  {
    title: "Gateway troubleshooting",
    desc: "The gateway runs locally. Start it with zintus serve — it listens on http://localhost:8788 by default. Point NEXT_PUBLIC_GATEWAY_URL elsewhere to use a different address.",
    href: "/docs#self-host",
    hue: 295,
    icon: <path d="M13 2 3 14h7l-1 8 10-12h-7z" />,
  },
  {
    title: "Providers & keys (BYOK)",
    desc: "Bring your own keys for OpenAI, Anthropic, Groq, and more. They stay on your device in the gateway keychain — never sent to Zintus servers.",
    href: "/providers",
    hue: 50,
    icon: (
      <>
        <circle cx="7.5" cy="15.5" r="5.5" />
        <path d="m21 2-9.6 9.6M15.5 7.5l3 3" />
      </>
    ),
  },
  {
    title: "MCP servers",
    desc: "Connect tools the assistant can use — local processes or remote URLs — through your gateway.",
    href: "/settings/mcp",
    hue: 162,
    icon: (
      <>
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </>
    ),
  },
  {
    title: "Privacy & no-custody",
    desc: "Why your keys and your conversations never touch our servers.",
    href: "/privacy",
    hue: 200,
    icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  },
  {
    title: "All docs",
    desc: "Quickstart, the OpenAI-compatible gateway API, routing, and self-hosting.",
    href: "/docs",
    hue: 250,
    icon: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </>
    ),
  },
];

// Popular articles — each is a real link, not a placeholder.
const ARTICLES: { title: string; href: string }[] = [
  { title: "Run the gateway with zintus serve", href: "/docs#self-host" },
  { title: "Add an OpenAI or Anthropic key (BYOK)", href: "/providers" },
  { title: "Connect an MCP server", href: "/settings/mcp" },
  { title: "How your keys stay on your device", href: "/privacy" },
  { title: "Read the full docs", href: "/docs" },
];

export default function HelpPage() {
  return (
    <div className="screen settings-screen">
      <div
        className="section-shell section-shell-narrow"
        style={{ display: "flex", flexDirection: "column", gap: 24 }}
      >
        <div style={sectionHeadStyle}>
          <span style={sectionTitleStyle}>Help &amp; docs</span>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
            How can we help?
          </h1>
          <span className="muted">
            Everything below links to a real page or your own gateway settings —
            no dead ends.
          </span>
        </div>

        <Section title="Browse by topic">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {TOPICS.map((t) => (
              <a
                key={t.title}
                href={t.href}
                className="settings-card"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    background: `oklch(60% 0.13 ${t.hue} / 0.18)`,
                    color: `oklch(75% 0.14 ${t.hue})`,
                  }}
                >
                  <Icon d={t.icon} />
                </span>
                <strong style={{ fontSize: 14.5 }}>{t.title}</strong>
                <span
                  className="muted"
                  style={{ fontSize: 12.5, lineHeight: 1.5 }}
                >
                  {t.desc}
                </span>
              </a>
            ))}
          </div>
        </Section>

        <Section title="Popular articles">
          <div
            style={{
              border: "0.5px solid var(--c-border)",
              borderRadius: 14,
              overflow: "hidden",
              background: "var(--color-surface)",
            }}
          >
            {ARTICLES.map((a, i) => (
              <a
                key={a.title}
                href={a.href}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "14px 18px",
                  borderBottom:
                    i < ARTICLES.length - 1
                      ? "0.5px solid var(--c-border)"
                      : "none",
                  textDecoration: "none",
                }}
              >
                <span style={{ color: "var(--color-text-muted)", display: "inline-flex" }}>
                  <Icon
                    d={
                      <>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </>
                    }
                  />
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 13.5,
                    color: "var(--color-text-sub)",
                  }}
                >
                  {a.title}
                </span>
                <span style={{ color: "var(--color-text-muted)", display: "inline-flex" }}>
                  <Icon d={<polyline points="9 18 15 12 9 6" />} />
                </span>
              </a>
            ))}
          </div>
        </Section>

        <div
          className="settings-card"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <strong style={{ fontSize: 14.5 }}>Still stuck?</strong>
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                color: "var(--color-text-muted)",
              }}
            >
              We reply within a day — or ask in the community.
            </div>
          </div>
          <a
            href="/docs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              height: 38,
              padding: "0 16px",
              borderRadius: 9,
              border: "0.5px solid var(--c-border-strong)",
              background: "var(--color-elevated)",
              color: "var(--color-text)",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Community
          </a>
          <a
            href="mailto:support@zintus.ai"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              height: 38,
              padding: "0 16px",
              borderRadius: 9,
              border: "none",
              background: "var(--c-accent)",
              color: "var(--c-accent-contrast)",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Contact support
          </a>
        </div>
      </div>
    </div>
  );
}
