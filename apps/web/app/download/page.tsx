import type { Metadata } from "next";
import Link from "next/link";
import { Container, Terminal, Monitor, Smartphone, ExternalLink } from "lucide-react";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { CommandBlock } from "./CommandBlock";

export const metadata: Metadata = {
  title: "Download Zintus — Docker, CLI, Desktop & Mobile",
  description:
    "Self-host the Zintus gateway with Docker, install the CLI from npm, or grab the desktop app. One BYOK config, all your devices.",
  alternates: { canonical: "/download" },
};

// Source of truth for the public artifact locations. Only real, published
// targets — verified against the repo's release workflows:
//   .github/workflows/release-gateway.yml  → GHCR image (v* tags)
//   .github/workflows/release-cli.yml      → npm `zintus` (cli-v* tags)
//   .github/workflows/release-desktop.yml  → Tauri bundles (desktop-v* tags)
//   .github/workflows/release-mobile.yml   → EAS build (mobile-v* tags)
const REPO_URL = "https://github.com/trustphoneapp/zintus";
const RELEASES_URL = `${REPO_URL}/releases`;
const GHCR_IMAGE = "ghcr.io/trustphoneapp/zintus-gateway";
const GHCR_PACKAGE_URL = `${REPO_URL}/pkgs/container/zintus-gateway`;

const sectionStyle: React.CSSProperties = {
  marginBottom: "2.75rem",
  paddingBottom: "2.5rem",
  borderBottom: "1px solid rgba(148,163,184,0.15)",
};
const iconWrap: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 38,
  height: 38,
  borderRadius: 10,
  background: "rgba(124,58,237,0.12)",
  border: "1px solid rgba(124,58,237,0.3)",
  flexShrink: 0,
};
const h2Style: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, color: "#e9d5ff", margin: 0 };
const leadStyle: React.CSSProperties = {
  fontSize: 14.5,
  color: "#94a3b8",
  lineHeight: 1.7,
  margin: "0.75rem 0 0",
  maxWidth: 680,
};
const linkBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13.5,
  fontWeight: 600,
  color: "#c4b5fd",
  textDecoration: "none",
  marginTop: "1rem",
};
const noteStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: "#7c6a9c",
  margin: "0.9rem 0 0",
  maxWidth: 680,
  lineHeight: 1.6,
};

function Header({
  icon: Icon,
  title,
  badge,
}: {
  icon: typeof Container;
  title: string;
  badge?: { text: string; tone: "ok" | "soon" };
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.85rem", flexWrap: "wrap" }}>
      <span style={iconWrap}>
        <Icon size={20} color="#a78bfa" />
      </span>
      <h2 style={h2Style}>{title}</h2>
      {badge ? (
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 999,
            color: badge.tone === "ok" ? "#86efac" : "#fde68a",
            background: badge.tone === "ok" ? "rgba(34,197,94,0.1)" : "rgba(234,179,8,0.08)",
            border:
              badge.tone === "ok"
                ? "1px solid rgba(34,197,94,0.3)"
                : "1px solid rgba(234,179,8,0.3)",
          }}
        >
          {badge.text}
        </span>
      ) : null}
    </div>
  );
}

export default function DownloadPage() {
  return (
    <main className="marketing-page">
      <Navbar />
      <section className="m-shell" style={{ padding: "4rem 0 6rem", minHeight: "60vh" }}>
        <h1 style={{ fontSize: "2.25rem", fontWeight: 700, marginBottom: "0.5rem", color: "#e9d5ff" }}>
          Get Zintus
        </h1>
        <p style={{ fontSize: 15, color: "#94a3b8", marginBottom: "3rem", maxWidth: 720, lineHeight: 1.7 }}>
          Zintus is local-first and BYOK — your keys live on your machine, not on a hosted
          control plane. Pick the surface that fits: self-host the gateway with Docker, install the
          CLI, or run the desktop app. One config works across all of them.
        </p>

        <div style={{ maxWidth: 760 }}>
          {/* ── Docker (gateway) ───────────────────────────── */}
          <section style={sectionStyle}>
            <Header icon={Container} title="Docker — self-host the gateway" badge={{ text: "Stable", tone: "ok" }} />
            <p style={leadStyle}>
              The recommended way to run the gateway as a service. Prebuilt images are published to
              GitHub Container Registry on every <code style={{ color: "#c4b5fd" }}>v*</code> release.
              Keys and <code style={{ color: "#c4b5fd" }}>quota.db</code> persist in a named volume;
              the container runs as a non-root user.
            </p>
            <CommandBlock
              label="DOCKER COMPOSE"
              lines={[
                "cp policy.example.json policy.json",
                "GATEWAY_TOKEN=$(openssl rand -hex 24) docker compose up -d",
                "curl -s localhost:8788/health | jq",
              ]}
            />
            <CommandBlock
              label="DOCKER RUN (PREBUILT IMAGE)"
              lines={[
                `docker pull ${GHCR_IMAGE}:latest`,
                `docker run -p 8788:8788 -e GATEWAY_TOKEN=secret \\`,
                `  -v "$HOME/.zintus:/home/bun/.zintus" ${GHCR_IMAGE}:latest`,
              ]}
            />
            <p style={noteStyle}>
              Exposing it beyond loopback? Set <code>GATEWAY_TOKEN</code>,{" "}
              <code>GATEWAY_RATELIMIT_RPM</code>, TLS and CORS first — see the{" "}
              <Link href="/docs" style={{ color: "#c4b5fd" }}>
                deployment docs
              </Link>
              .
            </p>
            <a href={GHCR_PACKAGE_URL} style={linkBtn} target="_blank" rel="noopener noreferrer">
              View image on GHCR <ExternalLink size={13} />
            </a>
          </section>

          {/* ── CLI ─────────────────────────────────────────── */}
          <section style={sectionStyle}>
            <Header icon={Terminal} title="CLI" badge={{ text: "Stable", tone: "ok" }} />
            <p style={leadStyle}>
              Install the <code style={{ color: "#c4b5fd" }}>zintus</code> command globally from npm.
              Keys are stored in your OS keychain — never sent anywhere. Runs on the Bun runtime.
            </p>
            <CommandBlock label="NPM" lines={["npm install -g zintus", "zintus init", "zintus chat \"hello\""]} />
            <p style={noteStyle}>
              Prefer to build from source? Clone the repo and run{" "}
              <code>bun install &amp;&amp; cd apps/cli &amp;&amp; bun run build</code>.
            </p>
            <a href={REPO_URL} style={linkBtn} target="_blank" rel="noopener noreferrer">
              Source on GitHub <ExternalLink size={13} />
            </a>
          </section>

          {/* ── Desktop ─────────────────────────────────────── */}
          <section style={sectionStyle}>
            <Header icon={Monitor} title="Desktop — macOS, Windows, Linux" badge={{ text: "Beta", tone: "soon" }} />
            <p style={leadStyle}>
              A native Tauri app with a built-in gateway, provider dashboard, and quota bars.
              Universal macOS, Windows (x64), and Linux builds are attached to each desktop release.
            </p>
            <p style={noteStyle}>
              Beta builds aren&apos;t code-signed for OS distribution yet, so macOS Gatekeeper and
              Windows SmartScreen may warn on first launch — open it from the security prompt to
              proceed. Always download from the official GitHub release below.
            </p>
            <a href={RELEASES_URL} style={linkBtn} target="_blank" rel="noopener noreferrer">
              Download from GitHub Releases <ExternalLink size={13} />
            </a>
          </section>

          {/* ── Mobile ──────────────────────────────────────── */}
          <section style={{ ...sectionStyle, borderBottom: "none", paddingBottom: 0 }}>
            <Header icon={Smartphone} title="Mobile — iOS & Android" badge={{ text: "Coming soon", tone: "soon" }} />
            <p style={leadStyle}>
              An Expo app to control your gateway remotely — switch providers, watch quota, and chat
              on the go. Production builds run through EAS; we&apos;re finishing store review.
            </p>
            <p style={noteStyle}>
              Coming to TestFlight (iOS) and Play internal testing (Android). No public store
              listing yet — we won&apos;t link a dead store. Watch the{" "}
              <Link href="/changelog" style={{ color: "#c4b5fd" }}>
                changelog
              </Link>{" "}
              for the rollout.
            </p>
          </section>
        </div>

        <Link href="/" style={{ display: "inline-block", marginTop: "2.5rem", fontSize: 14, color: "#c4b5fd", textDecoration: "none" }}>
          ← Back to homepage
        </Link>
      </section>
      <Footer />
    </main>
  );
}
