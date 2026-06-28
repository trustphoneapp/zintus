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

// GitHub's stable "latest release asset" redirect:
//   https://github.com/<owner>/<repo>/releases/latest/download/<asset>
// resolves to the same asset on whatever the newest (non-prerelease) release is.
// It only 200s once a release that actually attaches <asset> exists; until then
// it 404s — so we keep the Releases *page* as the live link and surface the
// direct URL/asset names as documentation, not as a working button yet.
//   docs: https://docs.github.com/repos/releases/linking-to-releases
const latestAsset = (name: string) => `${RELEASES_URL}/latest/download/${name}`;

// Tauri v2 default bundle filenames, derived from apps/desktop/src-tauri/
// tauri.conf.json (productName "Zintus") and the build matrix in
// .github/workflows/release-desktop.yml. <version> is the desktop-v* tag's
// version. Pattern refs:
//   DMG (universal-apple-darwin):   [productName]_[version]_universal.dmg
//   MSI/WiX (x86_64-pc-windows):    [productName]_[version]_x64_en-US.msi
// https://v2.tauri.app/distribute/dmg/  •  https://v2.tauri.app/distribute/windows-installer/
const MAC_DMG_NAME = "Zintus_<version>_universal.dmg";
const WIN_MSI_NAME = "Zintus_<version>_x64_en-US.msi";

// NOTE: release-desktop.yml now PUBLISHES a GitHub Release (tauri-action) on a
// `desktop-v*` tag, but no release has been cut yet (`gh release list` → []).
// Keep desktop badges as Beta / "download from Releases" until the first
// `desktop-v*` release attaches these assets — then the direct latest/download
// URLs below resolve. Do NOT claim "signed"/"notarized" — neither is true yet
// (macOS notarization + the Windows signCommand are [HUMAN]; see docs/store).

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
          control plane. The same gateway powers multi-provider routing and failover, tool
          calling, structured JSON output, and image input everywhere it runs. Pick the surface
          that fits: self-host with Docker, install the CLI, or run the desktop app (beta). One
          config works across all of them.
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

          {/* ── Desktop: macOS ──────────────────────────────── */}
          <section style={sectionStyle}>
            <Header icon={Monitor} title="macOS — desktop app" badge={{ text: "Beta", tone: "soon" }} />
            <p style={leadStyle}>
              A native Tauri app with a built-in gateway, provider dashboard, and quota bars.
              The macOS build is a Universal binary (Apple Silicon + Intel) attached to each{" "}
              <code style={{ color: "#c4b5fd" }}>desktop-v*</code> release as a <code>.dmg</code>.
            </p>
            {/* [HUMAN] Not notarized yet. Only add "notarized" once the build is run through
                Apple notarization — do NOT claim it before then. */}
            <p style={noteStyle}>
              Once the first <code>desktop-v*</code> release is published, the direct download is{" "}
              <code style={{ color: "#c4b5fd" }}>{latestAsset(MAC_DMG_NAME)}</code> (the{" "}
              <code>&lt;version&gt;</code> is filled in per release). Builds are{" "}
              <strong>not notarized</strong> yet, so Gatekeeper will warn on first launch — open it
              from the security prompt to proceed. Always grab it from the official Releases page.
            </p>
            <a href={RELEASES_URL} style={linkBtn} target="_blank" rel="noopener noreferrer">
              View desktop releases on GitHub <ExternalLink size={13} />
            </a>
          </section>

          {/* ── Desktop: Windows ────────────────────────────── */}
          <section style={sectionStyle}>
            <Header icon={Monitor} title="Windows — desktop app" badge={{ text: "Beta", tone: "soon" }} />
            <p style={leadStyle}>
              The same Tauri desktop app for Windows (x64), shipped as a WiX{" "}
              <code style={{ color: "#c4b5fd" }}>.msi</code> installer attached to each{" "}
              <code style={{ color: "#c4b5fd" }}>desktop-v*</code> release.
            </p>
            {/* [HUMAN] Not Authenticode-signed yet. Only add "signed (Authenticode)" once a code-
                signing cert is wired into release-desktop.yml — do NOT claim it before then. */}
            <p style={noteStyle}>
              Once the first <code>desktop-v*</code> release is published, the direct download is{" "}
              <code style={{ color: "#c4b5fd" }}>{latestAsset(WIN_MSI_NAME)}</code>. Builds are{" "}
              <strong>not code-signed (Authenticode)</strong> yet, so SmartScreen may warn — choose
              &ldquo;More info → Run anyway.&rdquo; Always grab it from the official Releases page.
            </p>
            <a href={RELEASES_URL} style={linkBtn} target="_blank" rel="noopener noreferrer">
              View desktop releases on GitHub <ExternalLink size={13} />
            </a>
          </section>

          {/* ── Desktop: Linux ──────────────────────────────── */}
          <section style={sectionStyle}>
            <Header icon={Monitor} title="Linux — desktop app" badge={{ text: "Beta", tone: "soon" }} />
            <p style={leadStyle}>
              Linux builds (x86_64) ship as <code style={{ color: "#c4b5fd" }}>.AppImage</code>,{" "}
              <code>.deb</code>, and <code>.rpm</code> bundles on each{" "}
              <code style={{ color: "#c4b5fd" }}>desktop-v*</code> release. Pick the package that
              matches your distro from the Releases page.
            </p>
            <a href={RELEASES_URL} style={linkBtn} target="_blank" rel="noopener noreferrer">
              View desktop releases on GitHub <ExternalLink size={13} />
            </a>
          </section>

          {/* ── Mobile: iOS ─────────────────────────────────── */}
          <section style={sectionStyle}>
            <Header icon={Smartphone} title="iOS" badge={{ text: "Coming soon", tone: "soon" }} />
            <p style={leadStyle}>
              An Expo app to control your gateway remotely — switch providers, watch quota, and chat
              on the go. Production builds run through EAS.
            </p>
            {/* No live App Store listing yet. Apple's marketing guidelines require the
                "Download on the App Store" badge to link to a live product page, so we use a
                plain text "Coming soon" instead of fabricating a badge / dead URL.
                https://developer.apple.com/app-store/marketing/guidelines/ */}
            <p style={noteStyle}>
              <strong>Coming soon — TestFlight on request.</strong> There&apos;s no public App Store
              listing yet, so we won&apos;t link a dead store or show an App Store badge until it
              resolves. Want early access?{" "}
              <Link href="/contact" style={{ color: "#c4b5fd" }}>
                Ask for a TestFlight invite
              </Link>
              .
            </p>
          </section>

          {/* ── Mobile: Android ─────────────────────────────── */}
          <section style={{ ...sectionStyle, borderBottom: "none", paddingBottom: 0 }}>
            <Header icon={Smartphone} title="Android" badge={{ text: "Coming soon", tone: "soon" }} />
            <p style={leadStyle}>
              The same Expo app for Android, built through EAS and headed to Google Play.
            </p>
            {/* No live Play listing yet. Google Play badge guidelines require the
                "Get it on Google Play" badge to drive downloads to a live listing, so we use a
                plain text "Coming soon" until it resolves.
                https://partnermarketinghub.withgoogle.com/brands/google-play/visual-identity/badge-guidelines/ */}
            <p style={noteStyle}>
              <strong>Coming soon.</strong> No public Play Store listing yet — we won&apos;t link a
              dead store or show a Google Play badge until it resolves. Watch the{" "}
              <Link href="/changelog" style={{ color: "#c4b5fd" }}>
                changelog
              </Link>{" "}
              for the rollout (internal testing first).
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
