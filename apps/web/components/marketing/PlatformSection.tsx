import Link from "next/link";
import { Terminal, Globe, Smartphone } from "lucide-react";

const CARDS = [
  {
    icon: Terminal,
    name: "CLI",
    lines: ["build from source (Bun)", "zintus chat 'hello'"],
    href: "#install",
    mono: true,
  },
  {
    icon: Globe,
    name: "Web",
    lines: ["zintus.ai/chat", "Works in any browser"],
    href: "/chat",
    mono: false,
  },
  {
    icon: Smartphone,
    name: "Mobile",
    lines: ["iOS & Android", "Control your gateway remotely"],
    href: "#install",
    mono: false,
  },
];

export function PlatformSection() {
  return (
    <section style={{ padding: "5rem 0" }}>
      <div className="m-shell">
        <h2 style={{ fontSize: "2rem", fontWeight: 700, textAlign: "center", color: "#e9d5ff" }}>
          Take it everywhere.
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
          Zintus works on your terminal, browser, desktop, and phone. One config,
          all devices.
        </p>

        <div className="platform-grid">
          {CARDS.map(({ icon: Icon, name, lines, href, mono }) => (
            <Link key={name} href={href} className="platform-card">
              <Icon size={22} color="#a78bfa" />
              <span className="platform-card-name">{name}</span>
              {lines.map((line) => (
                <span
                  key={line}
                  className="platform-card-line"
                  style={mono ? { fontFamily: "var(--font-jetbrains-mono), monospace" } : undefined}
                >
                  {line}
                </span>
              ))}
            </Link>
          ))}
        </div>

        <p style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, marginTop: "1.75rem" }}>
          Desktop app available for macOS, Windows, and Linux (beta).{" "}
          <Link href="/download" style={{ color: "#c4b5fd", textDecoration: "none" }}>
            See all downloads →
          </Link>
        </p>
      </div>
    </section>
  );
}
