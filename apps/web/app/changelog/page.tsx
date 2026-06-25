import type { Metadata } from "next";
import Link from "next/link";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";

export const metadata: Metadata = {
  title: "Changelog — Zintus",
  description:
    "Release notes for Zintus — security, reliability, and platform changes across each version.",
};

/* ─── data (mirrors the repo CHANGELOG.md) ───────────────── */
type Group = { heading: string; items: string[] };
type Release = {
  version: string;
  date?: string;
  summary: string;
  groups: Group[];
};

const RELEASES: Release[] = [
  {
    version: "Unreleased",
    summary: "Production-readiness follow-through — closes the remaining audit gaps on top of 0.2.0.",
    groups: [
      {
        heading: "Removed",
        items: [
          "Deleted the unwired managed-key scaffold (operator-decryptable, wired into zero routes) — it contradicted the BYOK-first zero-knowledge model. Recoverable from git history when a real client-wrapped design ships.",
        ],
      },
      {
        heading: "Security & billing",
        items: [
          "Managed-key paid tiers are gated \"Coming soon\" and Stripe checkout is disabled for them, so no one pays for an unbuilt feature. Single MANAGED_KEYS_AVAILABLE toggle across the relay and pricing page.",
        ],
      },
      {
        heading: "Reliability",
        items: [
          "Mid-stream SSE idle watchdog (GATEWAY_STREAM_IDLE_TIMEOUT_MS, default 60s) aborts a stalled upstream that stops sending chunks mid-stream.",
        ],
      },
      {
        heading: "Deployment",
        items: [
          "Docker image is now self-contained and hardened: builds tokzen's dist in-image, multi-stage, non-root USER bun, HEALTHCHECK, digest-pinned base. CI runs a docker run + /health smoke on PRs and main.",
        ],
      },
      {
        heading: "Web & legal",
        items: [
          "DRAFT privacy, terms, and security pages grounded in the real architecture (GDPR + CCPA + ToS), plus /.well-known/security.txt (RFC 9116). Banner-marked DRAFT pending legal review.",
        ],
      },
      {
        heading: "Docs",
        items: [
          "README savings endpoint corrected to the auth-gated /v1/status.",
          "Added a network-exposed deployment checklist (docs/DEPLOY.md).",
        ],
      },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-06-24",
    summary: "Production-hardening pass from the production-readiness audit.",
    groups: [
      {
        heading: "Security",
        items: [
          "/health no longer leaks provider topology — it returns only { ok, auth }. The full provider inventory, key presence, live quota, and savings moved to the auth-gated GET /v1/status.",
          "Per-client rate limiting on /v1/chat/completions and /v1/research via GATEWAY_RATELIMIT_RPM (keyed by client IP then bearer token; returns 429 + Retry-After). Off by default.",
          "Schema-validated request bodies (zod) at the gateway and the relay's public magic-link endpoint, via the new @zintus/schemas package.",
          "Rate-limit keying hardened: defaults to the unspoofable bearer token; X-Forwarded-For is trusted only behind a configured reverse proxy.",
          "CI security job: bun audit (high) plus gitleaks secret scanning over full history.",
        ],
      },
      {
        heading: "Reliability",
        items: [
          "Provider fetches are cancellable — an AbortSignal threads RouteRequest → router → provider fetch, releasing in-flight quota on disconnect/timeout instead of leaking it.",
          "Graceful shutdown drains in-flight streams on SIGTERM/SIGINT, flips /health to 503 draining, and closes the cloud relay connection, bounded by GATEWAY_DRAIN_TIMEOUT_MS.",
          "Circuit-breaker half-open gate: a recovering provider admits a single probe at a time so a concurrent burst can't all rush a provider that may still be down.",
        ],
      },
      {
        heading: "Observability",
        items: [
          "Opt-in error sink wires onError → Sentry via SENTRY_DSN (dynamically loaded; zero dependency when unset). New zintus_gateway_rate_limited_total Prometheus counter.",
        ],
      },
      {
        heading: "Performance",
        items: [
          "memory-store indexes on thread_id (plus a thread_id,key composite), removing full-table scans on every memory read path.",
        ],
      },
      {
        heading: "Docs",
        items: [
          "Added docs/PRODUCTION-ARCHITECTURE.md, a root .env.example, this changelog, and expanded SECURITY.md.",
        ],
      },
    ],
  },
];

/* ─── styles ─────────────────────────────────────────────── */
const groupHeading: React.CSSProperties = {
  fontSize: "0.8rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#c4b5fd",
  margin: "1.25rem 0 0.5rem",
};

export default function ChangelogPage() {
  return (
    <main className="marketing-page">
      <Navbar />
      <section className="m-shell" style={{ padding: "4rem 0 6rem", minHeight: "60vh" }}>
        <h1
          style={{
            fontSize: "2.25rem",
            fontWeight: 700,
            marginBottom: "0.5rem",
            color: "#e9d5ff",
          }}
        >
          Changelog
        </h1>
        <p style={{ fontSize: 14, color: "#64748b", marginBottom: "2.5rem", maxWidth: 760 }}>
          Notable changes to Zintus. Format loosely follows{" "}
          <a
            href="https://keepachangelog.com/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#c4b5fd" }}
          >
            Keep a Changelog
          </a>
          ; pre-1.0, so minor versions may include breaking changes.
        </p>

        <div style={{ maxWidth: 760 }}>
          {RELEASES.map((release) => (
            <section
              key={release.version}
              style={{
                marginBottom: "3rem",
                paddingBottom: "2rem",
                borderBottom: "1px solid rgba(148,163,184,0.15)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
                <h2 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#e9d5ff" }}>
                  {release.version}
                </h2>
                {release.date ? (
                  <span style={{ fontSize: 13, color: "#64748b" }}>{release.date}</span>
                ) : (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#fde68a",
                      background: "rgba(234,179,8,0.08)",
                      border: "1px solid rgba(234,179,8,0.3)",
                      borderRadius: 4,
                      padding: "1px 6px",
                    }}
                  >
                    in progress
                  </span>
                )}
              </div>
              <p style={{ fontSize: 15, color: "#94a3b8", lineHeight: 1.7, marginTop: "0.5rem" }}>
                {release.summary}
              </p>

              {release.groups.map((group) => (
                <div key={group.heading}>
                  <p style={groupHeading}>{group.heading}</p>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "1.25rem",
                      fontSize: 14.5,
                      color: "#94a3b8",
                      lineHeight: 1.7,
                    }}
                  >
                    {group.items.map((item, i) => (
                      <li key={i} style={{ marginBottom: "0.4rem" }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>

        <Link
          href="/"
          style={{
            display: "inline-block",
            marginTop: "1rem",
            fontSize: 14,
            color: "#c4b5fd",
            textDecoration: "none",
          }}
        >
          ← Back to homepage
        </Link>
      </section>
      <Footer />
    </main>
  );
}
