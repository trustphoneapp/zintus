"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { createCheckout } from "@/lib/billing";

/* ─── types ─────────────────────────────────────────────── */
type Tier = "starter" | "growth" | "scale";

// Managed-key paid tiers are listed here, but their backend (Zintus-managed key
// custody) is not yet built — the relay scaffold was removed. Until it ships,
// checkout is disabled and the tiers render as "Coming soon". Flip to true to
// re-enable once managed keys are live (mirrors MANAGED_KEYS_AVAILABLE in the
// relay's tiers.ts, which guards the checkout endpoint server-side).
const MANAGED_KEYS_AVAILABLE = false;

/* ─── data ───────────────────────────────────────────────── */
const FREE_FEATURES = [
  "12 providers via your own keys",
  "Keys stored in OS keychain",
  "Smart quota routing",
  "Ollama offline fallback",
  "CLI + Desktop + Web",
  "No credit card required",
];

const GROWTH_FEATURES = [
  "Everything in Free",
  "Zintus manages your keys (coming soon)",
  "Works on mobile",
  "5M tokens / month",
  "20 concurrent requests",
  "300 RPM",
  "Priority routing",
  "Usage dashboard",
  "API access",
];

const SCALE_FEATURES = [
  "Everything in Growth",
  "20M tokens / month",
  "Unlimited concurrent",
  "Unlimited RPM",
  "Dedicated lane",
  "Batch processing",
  "Custom model priority",
];

const COMPARISON_ROWS: Array<{
  feature: string;
  free: string;
  starter: string;
  growth: string;
  scale: string;
}> = [
  { feature: "API keys", free: "Your own", starter: "Zintus", growth: "Zintus", scale: "Zintus" },
  { feature: "Tokens / month", free: "Unlimited (BYOK)", starter: "500K", growth: "5M", scale: "20M" },
  { feature: "Works on mobile", free: "—", starter: "Yes", growth: "Yes", scale: "Yes" },
  { feature: "Concurrent", free: "Unlimited (local)", starter: "5", growth: "20", scale: "Unlimited" },
  { feature: "Rate limit", free: "Provider limit", starter: "60 RPM", growth: "300 RPM", scale: "Unlimited" },
  { feature: "Usage dashboard", free: "—", starter: "Yes", growth: "Yes", scale: "Yes" },
];

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "What is BYOK (Bring Your Own Key)?",
    a: "BYOK means you sign up for free-tier API keys from providers like Cerebras, Groq, and Gemini, then store them in your OS keychain via zintus init. Zintus routes requests across those keys — you never share them with Zintus servers.",
  },
  {
    q: "Why upgrade to a Pro tier?",
    a: "Pro tiers (Starter, Growth, Scale) let Zintus manage the API keys for you. No sign-ups, no key juggling, no quota headaches. You get a single token budget backed by Zintus-maintained provider accounts.",
  },
  {
    q: "What happens when I hit my token limit?",
    a: "Requests return a 429 with a clear error message. You won't be billed for overages. Upgrade or wait for the next billing cycle — your data is never deleted.",
  },
  {
    q: "Can I cancel at any time?",
    a: "Yes — when paid tiers launch. You'll be able to cancel anytime from the billing dashboard and keep access until the period ends, with no cancellation fees. (Paid tiers aren't purchasable yet.)",
  },
  {
    q: "How does the referral program work?",
    a: "A referral program is planned for when paid tiers launch: you'll share a referral link from the billing dashboard, and each confirmed referral will earn credit toward your subscription, applied automatically at the start of the next billing cycle. It isn't live yet.",
  },
];

/* ─── helpers ────────────────────────────────────────────── */
function Check() {
  return (
    <span
      aria-hidden="true"
      style={{ color: "var(--marketing-accent-light)", marginRight: "0.5rem" }}
    >
      ✓
    </span>
  );
}

/* ─── inner component (uses useSearchParams) ─────────────── */
function PricingInner() {
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? undefined;

  const [loadingTier, setLoadingTier] = useState<Tier | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  async function handleUpgrade(tier: Tier) {
    // Guarded: managed-key tiers aren't purchasable until the backend ships.
    // Buttons are disabled too; this is belt-and-suspenders.
    if (!MANAGED_KEYS_AVAILABLE) return;
    setLoadingTier(tier);
    const url = await createCheckout(tier, ref);
    setLoadingTier(null);
    if (url) {
      window.location.href = url;
    }
  }

  const cardBase: React.CSSProperties = {
    background: "var(--marketing-surface)",
    border: "1px solid var(--marketing-accent-dim)",
    borderRadius: "12px",
    padding: "2rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    flex: "1 1 260px",
    minWidth: 0,
  };

  const growthCard: React.CSSProperties = {
    ...cardBase,
    borderColor: "var(--marketing-accent)",
    position: "relative",
  };

  return (
    <main className="marketing-page">
      <Navbar />

      {/* Hero */}
      <section className="m-section">
        <div className="m-shell" style={{ textAlign: "center" }}>
          <p className="m-eyebrow">Pricing</p>
          <h1 className="m-title">All the AI you need.<br />None of the bills.</h1>
          <p className="m-subtitle">
            Start free with your own keys. Scale with ours.
          </p>
        </div>
      </section>

      {/* Three main cards */}
      <section className="m-section" style={{ paddingTop: 0 }}>
        <div
          className="m-shell"
          style={{
            display: "flex",
            gap: "1.5rem",
            flexWrap: "wrap",
            alignItems: "flex-start",
          }}
        >
          {/* Free */}
          <div style={cardBase}>
            <div>
              <p style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--marketing-text)" }}>
                Free
              </p>
              <p style={{ fontSize: "2rem", fontWeight: 800, color: "var(--marketing-text)", lineHeight: 1.1, marginTop: "0.5rem" }}>
                $0
                <span style={{ fontSize: "0.9rem", fontWeight: 400, opacity: 0.6 }}> / forever</span>
              </p>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem", flex: 1 }}>
              {FREE_FEATURES.map((f) => (
                <li key={f} style={{ fontSize: "0.9rem", color: "var(--marketing-muted)" }}>
                  <Check />{f}
                </li>
              ))}
            </ul>
            <a href="/login" className="m-ghost-btn" style={{ textAlign: "center", display: "block" }}>
              Start for free
            </a>
          </div>

          {/* Growth — highlighted */}
          <div style={growthCard}>
            <div
              style={{
                position: "absolute",
                top: "-0.75rem",
                left: "50%",
                transform: "translateX(-50%)",
                background: "var(--marketing-accent)",
                color: "#fff",
                fontSize: "0.7rem",
                fontWeight: 700,
                letterSpacing: "0.08em",
                padding: "0.2rem 0.75rem",
                borderRadius: "99px",
                whiteSpace: "nowrap",
              }}
            >
              COMING SOON
            </div>
            <div>
              <p style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--marketing-text)" }}>
                Growth
              </p>
              <p style={{ fontSize: "2rem", fontWeight: 800, color: "var(--marketing-text)", lineHeight: 1.1, marginTop: "0.5rem" }}>
                $99
                <span style={{ fontSize: "0.9rem", fontWeight: 400, opacity: 0.6 }}> / mo</span>
              </p>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem", flex: 1 }}>
              {GROWTH_FEATURES.map((f) => (
                <li key={f} style={{ fontSize: "0.9rem", color: "var(--marketing-muted)" }}>
                  <Check />{f}
                </li>
              ))}
            </ul>
            <button
              className="m-primary-btn"
              style={{ width: "100%", cursor: !MANAGED_KEYS_AVAILABLE ? "not-allowed" : loadingTier === "growth" ? "wait" : "pointer" }}
              onClick={() => handleUpgrade("growth")}
              disabled={!MANAGED_KEYS_AVAILABLE || loadingTier !== null}
            >
              {!MANAGED_KEYS_AVAILABLE ? "Coming soon" : loadingTier === "growth" ? "Redirecting…" : "Upgrade to Growth"}
            </button>
          </div>

          {/* Scale */}
          <div style={cardBase}>
            <div>
              <p style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--marketing-text)" }}>
                Scale
              </p>
              <p style={{ fontSize: "2rem", fontWeight: 800, color: "var(--marketing-text)", lineHeight: 1.1, marginTop: "0.5rem" }}>
                $200
                <span style={{ fontSize: "0.9rem", fontWeight: 400, opacity: 0.6 }}> / mo</span>
              </p>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem", flex: 1 }}>
              {SCALE_FEATURES.map((f) => (
                <li key={f} style={{ fontSize: "0.9rem", color: "var(--marketing-muted)" }}>
                  <Check />{f}
                </li>
              ))}
            </ul>
            <button
              className="m-ghost-btn"
              style={{ width: "100%", cursor: !MANAGED_KEYS_AVAILABLE ? "not-allowed" : loadingTier === "scale" ? "wait" : "pointer" }}
              onClick={() => handleUpgrade("scale")}
              disabled={!MANAGED_KEYS_AVAILABLE || loadingTier !== null}
            >
              {!MANAGED_KEYS_AVAILABLE ? "Coming soon" : loadingTier === "scale" ? "Redirecting…" : "Upgrade to Scale"}
            </button>
          </div>
        </div>
      </section>

      {/* Starter callout */}
      <section className="m-section" style={{ paddingTop: 0 }}>
        <div className="m-shell">
          <div
            style={{
              background: "var(--marketing-surface)",
              border: "1px solid var(--marketing-accent-dim)",
              borderRadius: "12px",
              padding: "1.25rem 2rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "1rem",
            }}
          >
            <div>
              <span
                style={{
                  fontWeight: 700,
                  color: "var(--marketing-text)",
                  fontSize: "1rem",
                }}
              >
                Starter — $15 / month
              </span>
              <span
                style={{
                  marginLeft: "1rem",
                  color: "var(--marketing-muted)",
                  fontSize: "0.9rem",
                }}
              >
                500K tokens · Zintus-managed keys (coming soon) · Works on mobile
              </span>
            </div>
            <button
              className="m-ghost-btn"
              style={{ cursor: !MANAGED_KEYS_AVAILABLE ? "not-allowed" : loadingTier === "starter" ? "wait" : "pointer", whiteSpace: "nowrap" }}
              onClick={() => handleUpgrade("starter")}
              disabled={!MANAGED_KEYS_AVAILABLE || loadingTier !== null}
            >
              {!MANAGED_KEYS_AVAILABLE ? "Coming soon" : loadingTier === "starter" ? "Redirecting…" : "Get Starter"}
            </button>
          </div>
        </div>
      </section>

      {/* Comparison table */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title" style={{ marginBottom: "1.5rem" }}>Compare plans</h2>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
                color: "var(--marketing-muted)",
              }}
            >
              <thead>
                <tr>
                  {["Feature", "Free", "Starter $15", "Growth $99", "Scale $200"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: h === "Feature" ? "left" : "center",
                        padding: "0.75rem 1rem",
                        borderBottom: "1px solid var(--marketing-accent-dim)",
                        color: "var(--marketing-text)",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row, i) => (
                  <tr
                    key={row.feature}
                    style={{ background: i % 2 === 0 ? "transparent" : "var(--marketing-accent-soft)" }}
                  >
                    <td style={{ padding: "0.75rem 1rem", color: "var(--marketing-text)", fontWeight: 500 }}>
                      {row.feature}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "center" }}>{row.free}</td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "center" }}>{row.starter}</td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "center" }}>{row.growth}</td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "center" }}>{row.scale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title" style={{ marginBottom: "1.5rem" }}>FAQ</h2>
          <div className="m-faq">
            {FAQS.map((faq, i) => (
              <div key={faq.q} className="m-faq-item">
                <button
                  type="button"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  style={{
                    width: "100%",
                    background: "none",
                    border: "none",
                    padding: "1rem 1.05rem",
                    textAlign: "left",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "1rem",
                    color: "var(--marketing-text)",
                    fontWeight: 600,
                    fontSize: "0.95rem",
                  }}
                >
                  {faq.q}
                  <span
                    style={{
                      flexShrink: 0,
                      transition: "transform 0.2s",
                      transform: openFaq === i ? "rotate(180deg)" : "rotate(0deg)",
                      color: "var(--marketing-accent-light)",
                    }}
                  >
                    ▾
                  </span>
                </button>
                {openFaq === i && (
                  <p
                    style={{
                      margin: 0,
                      padding: "0 1.05rem 1rem",
                      color: "var(--marketing-muted)",
                      fontSize: "0.9rem",
                      lineHeight: 1.7,
                    }}
                  >
                    {faq.a}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}

/* ─── page export with Suspense (required for useSearchParams) ── */
export default function PricingPage() {
  return (
    <Suspense>
      <PricingInner />
    </Suspense>
  );
}
