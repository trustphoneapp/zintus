"use client";

import { ZintusLogo } from "@/components/ZintusLogo";

const LINKS = {
  Product: [
    { label: "Pricing", href: "/pricing" },
    { label: "Docs", href: "/docs" },
    { label: "Chat", href: "/chat" },
    { label: "Changelog", href: "#" },
  ],
  Legal: [
    { label: "Security", href: "#" },
    { label: "Privacy", href: "#" },
    { label: "License (BUSL-1.1)", href: "#" },
  ],
};

export function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid rgba(124,58,237,0.12)",
        paddingTop: "3rem",
        paddingBottom: "3rem",
      }}
    >
      <div className="m-shell">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto",
            gap: "3rem",
            alignItems: "start",
            marginBottom: "2.5rem",
          }}
        >
          <div>
            <ZintusLogo size="sm" showWordmark />
            <p
              style={{
                marginTop: "1rem",
                fontSize: 13,
                color: "#4a3070",
                maxWidth: 260,
                lineHeight: 1.7,
              }}
            >
              Open-source AI router. BYOK. Zero markup. Routes intelligently across 12 free
              providers.
            </p>
          </div>
          {Object.entries(LINKS).map(([section, links]) => (
            <div key={section}>
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#4a3070",
                  marginBottom: "1rem",
                }}
              >
                {section}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {links.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    style={{ fontSize: 13, color: "#64748b", textDecoration: "none" }}
                    onMouseOver={(e) => {
                      (e.currentTarget as HTMLAnchorElement).style.color = "#c4b5fd";
                    }}
                    onMouseOut={(e) => {
                      (e.currentTarget as HTMLAnchorElement).style.color = "#64748b";
                    }}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            borderTop: "1px solid rgba(124,58,237,0.08)",
            paddingTop: "1.5rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 12, color: "#4a3070" }}>
            © 2026 Zintus · Business Source License 1.1
          </span>
          <span style={{ fontSize: 12, color: "#4a3070" }}>YS Ventures LLC</span>
        </div>
      </div>
    </footer>
  );
}
