"use client";

import { useEffect, useState } from "react";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { createCheckout } from "@/lib/billing";
import { getMe } from "@/lib/cloud";

/* ─── palette ────────────────────────────────────────────── */
const VIOLET = "var(--marketing-accent)"; // #7C3AED brand glow
const GREEN = "#22C55E";
const RED = "#EF4444";

/* ─── tier data ──────────────────────────────────────────── */
type Cta =
  | { kind: "link"; label: string; href: string }
  | { kind: "checkout"; label: string };

type TierCard = {
  id: string;
  badge: string;
  price: string;
  per?: string;
  pill: string;
  features: string[];
  cta: Cta;
  borderColor: string;
  ribbon?: string;
  ribbonColor?: string;
};

const TIERS: TierCard[] = [
  {
    id: "free",
    badge: "Free",
    price: "$0",
    pill: "Unlimited BYOK",
    features: [
      "12+ providers, your own keys",
      "Keys never leave your device",
      "Smart routing active",
      "Ollama + local model support",
      "Real-time quota tracking",
    ],
    // Free chat is live today.
    cta: { kind: "link", label: "Start free", href: "/chat" },
    borderColor: "var(--marketing-accent-dim)",
  },
  {
    id: "starter",
    badge: "Starter",
    price: "$15",
    per: "/mo",
    pill: "1,000,000 tokens / month",
    features: [
      "Tier 0 + Tier 1 model access",
      "Exact token balance always visible",
      "No 5-hour windows or weekly caps",
      "Token balance resets on billing date",
      "BYOK frontier on top (your key)",
    ],
    cta: { kind: "checkout", label: "Get started" },
    borderColor: GREEN,
    ribbon: "Most popular",
    ribbonColor: GREEN,
  },
  {
    id: "pro",
    badge: "Pro",
    price: "$49",
    per: "/mo",
    pill: "10,000,000 tokens / month",
    features: [
      "Tier 0 + Tier 1 + Tier 2 access",
      "Up to a top-tier reasoning model",
      "Priority routing",
      "Usage history dashboard",
      "BYOK frontier on top (your key)",
    ],
    cta: { kind: "checkout", label: "Get started" },
    borderColor: VIOLET,
  },
  {
    id: "max",
    badge: "Max",
    price: "$99",
    per: "/mo",
    pill: "50,000,000 tokens / month",
    features: [
      "Full T0 → T2 model roster",
      "Usage dashboard API access",
      "Referral program (20% recurring)",
      "Priority support",
      "BYOK any frontier model",
    ],
    cta: { kind: "checkout", label: "Get started" },
    borderColor: "var(--marketing-accent-dim)",
  },
  {
    id: "ultra",
    badge: "Ultra",
    price: "$199",
    per: "/mo",
    pill: "200,000,000 tokens / month",
    features: [
      "All managed models",
      "Overflow at cost (no hard stop)",
      "Team usage dashboard",
      "Referral program (20% recurring)",
      "BYOK any frontier model",
    ],
    cta: { kind: "checkout", label: "Get started" },
    borderColor: "var(--marketing-accent-dim)",
  },
];

/* ─── trust callouts ─────────────────────────────────────── */
const TRUST: Array<{ title: string; body: string }> = [
  {
    title: "No hidden windows",
    body: "Your tokens are available any time of day. No 5-hour resets. No weekly caps. No peak-hour throttle. Same balance at 3 AM as 3 PM.",
  },
  {
    title: "No silent downgrades",
    body: "Your balance is always visible. Every response shows the model used and tokens consumed. We warn before budget runs low. We never swap your model without telling you.",
  },
  {
    title: "BYOK frontier always free",
    body: "Add your own provider key on any paid tier. Route to any frontier model at direct provider rates. Zero markup. Counted against your own provider credits, not your quota.",
  },
];

/* ─── comparison rows ────────────────────────────────────── */
type Transparency = "hidden" | "shown";
const COMPARISON: Array<{
  plan: string;
  price: string;
  tokens: string;
  transparency: Transparency;
  zintus?: boolean;
}> = [
  { plan: "$0 free tier", price: "$0", tokens: "Rate-limited, rolling window", transparency: "hidden" },
  { plan: "$20 subscription", price: "$20", tokens: "Window-based, varies widely", transparency: "hidden" },
  { plan: "$100 tier", price: "$100", tokens: "5× window (still hidden)", transparency: "hidden" },
  { plan: "$200 tier", price: "$200", tokens: "20× window (still hidden)", transparency: "hidden" },
  { plan: "Zintus Starter", price: "$15", tokens: "1,000,000 exact", transparency: "shown", zintus: true },
  { plan: "Zintus Pro", price: "$49", tokens: "10,000,000 exact", transparency: "shown", zintus: true },
  { plan: "Zintus Max", price: "$99", tokens: "50,000,000 exact", transparency: "shown", zintus: true },
  { plan: "Zintus Ultra", price: "$199", tokens: "200,000,000 exact", transparency: "shown", zintus: true },
];

/* ─── per-model plan-token rates ─────────────────────────── */
// MUST mirror workers/relay/src/tiers.ts (CLASS_BURN + TIERS): burn = credits
// per 1K model tokens; a plan token displays as allowance/(credits×1000) of a
// credit. Rate shown = plan tokens debited per 1K model tokens — the exact
// number the app's receipts use. Relay tests pin the server side; if tiers.ts
// changes, regenerate these rows. Only classes with LIVE managed models are
// listed (no aspirational rows for unservable models).
const RATE_TIERS = [
  { id: "starter", label: "Starter", allowance: 1_000_000, credits: 15_000 },
  { id: "pro", label: "Pro", allowance: 10_000_000, credits: 35_000 },
  { id: "max", label: "Max", allowance: 50_000_000, credits: 60_000 },
  { id: "ultra", label: "Ultra", allowance: 200_000_000, credits: 120_000 },
] as const;

const RATE_CLASSES = [
  { label: "Fast models", examples: "Llama 8B, DeepSeek Flash", burn: 1, minTier: "starter" },
  { label: "Everyday models", examples: "GPT-4o mini", burn: 2, minTier: "starter" },
  { label: "Advanced models", examples: "Llama 70B, Kimi K2", burn: 5, minTier: "pro" },
] as const;

const TIER_ORDER = ["starter", "pro", "max", "ultra"] as const;

/** Plan tokens debited per 1K model tokens for a class on a tier. */
function planPer1k(burn: number, tier: (typeof RATE_TIERS)[number]): number {
  return Math.round((burn * 1000 * tier.allowance) / (tier.credits * 1000));
}

/* ─── referral rows ──────────────────────────────────────── */
const REFERRALS: Array<{ tier: string; price: string; reward: string }> = [
  { tier: "Starter", price: "$15", reward: "$15 one-time per referral" },
  { tier: "Pro", price: "$49", reward: "20% recurring · $9.80/mo · $117.60/year" },
  { tier: "Max", price: "$99", reward: "20% recurring · $19.80/mo · $237.60/year" },
  { tier: "Ultra", price: "$199", reward: "20% recurring · $39.80/mo · $477.60/year" },
];

/* ─── helpers ────────────────────────────────────────────── */
function Check() {
  return (
    <span aria-hidden="true" style={{ color: "var(--marketing-accent-light)", marginRight: "0.5rem" }}>
      ✓
    </span>
  );
}

function StatusBadge({ kind, children }: { kind: Transparency; children: string }) {
  const color = kind === "shown" ? GREEN : RED;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.6rem",
        borderRadius: "99px",
        fontSize: "0.78rem",
        fontWeight: 600,
        color,
        background: `${color}1f`,
        border: `1px solid ${color}55`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* ─── page ───────────────────────────────────────────────── */
type PaidTier = "starter" | "pro" | "max" | "ultra";
const PAID_TIERS: readonly string[] = ["starter", "pro", "max", "ultra"];

/** Referral code for this visit: ?ref= wins, else the 30-day zintus_ref
 *  cookie set by /r/<code>. */
function currentRef(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get("ref");
  if (fromQuery) return fromQuery;
  const m = /(?:^|;\s*)zintus_ref=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export default function PricingPage() {
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState("");

  async function handleCheckout(tierId: string) {
    if (!PAID_TIERS.includes(tierId) || busyTier) return;
    setBusyTier(tierId);
    setCheckoutError("");
    const ref = currentRef();

    // Signed out → login, then bounce straight back into this checkout via
    // the ?checkout= resume param (see useEffect below).
    const me = await getMe();
    if (!me.authenticated) {
      const resume = `/pricing?checkout=${tierId}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
      window.location.href = `/login?next=${encodeURIComponent(resume)}`;
      return;
    }

    const url = await createCheckout(tierId as PaidTier, ref);
    if (url) {
      window.location.href = url; // Stripe-hosted checkout
      return;
    }
    setCheckoutError(
      "Could not start checkout — please try again in a moment. If this keeps happening, billing may not be enabled yet.",
    );
    setBusyTier(null);
  }

  // Resume a checkout the user started before signing in.
  useEffect(() => {
    const tier = new URLSearchParams(window.location.search).get("checkout");
    if (tier && PAID_TIERS.includes(tier)) void handleCheckout(tier);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cardBase: React.CSSProperties = {
    background: "var(--marketing-surface)",
    border: "1px solid var(--marketing-accent-dim)",
    borderRadius: "12px",
    padding: "1.75rem 1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    flex: "1 1 220px",
    minWidth: 0,
    position: "relative",
  };

  const pillStyle: React.CSSProperties = {
    display: "inline-block",
    alignSelf: "flex-start",
    padding: "0.3rem 0.7rem",
    borderRadius: "99px",
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "var(--marketing-accent-light)",
    background: "var(--marketing-accent-soft)",
    border: "1px solid var(--marketing-accent-dim)",
  };

  return (
    <main className="marketing-page">
      <Navbar />

      {/* Hero */}
      <section className="m-section">
        <div className="m-shell" style={{ textAlign: "center" }}>
          <p className="m-eyebrow">Pricing</p>
          <h1 className="m-title">They sell you windows. We sell you tokens.</h1>
          <p className="m-subtitle" style={{ maxWidth: "640px", margin: "0.75rem auto 0" }}>
            Every plan shows an exact monthly token count before you pay. No rolling windows. No compute credits. No
            peak-hour throttling.
          </p>
        </div>
      </section>

      {/* Tier cards */}
      <section className="m-section" style={{ paddingTop: 0 }}>
        <div
          className="m-shell"
          style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", alignItems: "stretch" }}
        >
          {TIERS.map((tier) => (
            <div
              key={tier.id}
              style={{
                ...cardBase,
                borderColor: tier.borderColor,
                ...(tier.borderColor !== "var(--marketing-accent-dim)"
                  ? { boxShadow: `0 0 0 1px ${tier.borderColor}` }
                  : {}),
              }}
            >
              {tier.ribbon && (
                <div
                  style={{
                    position: "absolute",
                    top: "-0.75rem",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: tier.ribbonColor ?? VIOLET,
                    color: "#fff",
                    fontSize: "0.68rem",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    padding: "0.2rem 0.75rem",
                    borderRadius: "99px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tier.ribbon}
                </div>
              )}

              <div>
                <p style={{ fontWeight: 700, fontSize: "1rem", color: "var(--marketing-text)" }}>{tier.badge}</p>
                <p
                  style={{
                    fontSize: "1.85rem",
                    fontWeight: 800,
                    color: "var(--marketing-text)",
                    lineHeight: 1.1,
                    marginTop: "0.4rem",
                  }}
                >
                  {tier.price}
                  {tier.per && <span style={{ fontSize: "0.85rem", fontWeight: 400, opacity: 0.6 }}> {tier.per}</span>}
                </p>
              </div>

              <span style={pillStyle}>{tier.pill}</span>

              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  flex: 1,
                }}
              >
                {tier.features.map((f) => (
                  <li key={f} style={{ fontSize: "0.85rem", color: "var(--marketing-muted)", lineHeight: 1.4 }}>
                    <Check />
                    {f}
                  </li>
                ))}
              </ul>

              {tier.cta.kind === "link" ? (
                <a href={tier.cta.href} className="m-primary-btn" style={{ textAlign: "center", display: "block" }}>
                  {tier.cta.label}
                </a>
              ) : (
                <button
                  type="button"
                  className="m-primary-btn"
                  style={{ width: "100%" }}
                  onClick={() => handleCheckout(tier.id)}
                  disabled={busyTier !== null}
                >
                  {busyTier === tier.id ? "Opening checkout…" : tier.cta.label}
                </button>
              )}
            </div>
          ))}
        </div>
        {checkoutError ? (
          <div className="m-shell" style={{ marginTop: "0.75rem" }}>
            <p style={{ color: RED, fontSize: "0.9rem", margin: 0 }}>{checkoutError}</p>
          </div>
        ) : null}
      </section>

      {/* Trust callouts */}
      <section className="m-section" style={{ paddingTop: 0 }}>
        <div className="m-shell" style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
          {TRUST.map((t) => (
            <div
              key={t.title}
              style={{
                background: "var(--marketing-surface)",
                border: "1px solid var(--marketing-accent-dim)",
                borderRadius: "12px",
                padding: "1.5rem",
                flex: "1 1 280px",
                minWidth: 0,
              }}
            >
              <p style={{ fontWeight: 700, color: "var(--marketing-text)", fontSize: "1rem", marginBottom: "0.5rem" }}>
                {t.title}
              </p>
              <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.88rem", lineHeight: 1.6 }}>
                {t.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Per-model plan-token rates */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title" style={{ marginBottom: "0.75rem" }}>
            What each model costs in plan tokens
          </h2>
          <p className="m-subtitle" style={{ maxWidth: "680px", marginBottom: "1.5rem" }}>
            The exact debit per 1,000 model tokens — the same number every
            receipt in the app shows. Faster models debit less, advanced models
            debit more. No hidden multipliers.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
                minWidth: "560px",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--marketing-accent-dim)" }}>
                  <th style={{ textAlign: "left", padding: "0.6rem 0.75rem", color: "var(--marketing-muted)" }}>
                    Model class
                  </th>
                  {RATE_TIERS.map((t) => (
                    <th key={t.id} style={{ textAlign: "right", padding: "0.6rem 0.75rem", color: "var(--marketing-muted)" }}>
                      {t.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {RATE_CLASSES.map((cls) => (
                  <tr key={cls.label} style={{ borderBottom: "1px solid var(--marketing-accent-dim)" }}>
                    <td style={{ padding: "0.6rem 0.75rem" }}>
                      <span style={{ fontWeight: 600, color: "var(--marketing-text)" }}>{cls.label}</span>
                      <span style={{ color: "var(--marketing-muted)", display: "block", fontSize: "0.8rem" }}>
                        {cls.examples}
                      </span>
                    </td>
                    {RATE_TIERS.map((t) => {
                      const locked =
                        TIER_ORDER.indexOf(t.id) < TIER_ORDER.indexOf(cls.minTier);
                      return (
                        <td
                          key={t.id}
                          style={{
                            textAlign: "right",
                            padding: "0.6rem 0.75rem",
                            color: locked ? "var(--marketing-muted)" : "var(--marketing-text)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {locked ? "Upgrade" : `−${planPer1k(cls.burn, t).toLocaleString()} / 1K`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: "var(--marketing-muted)", fontSize: "0.8rem", marginTop: "0.75rem" }}>
            Rates differ per plan because each plan carries a different token
            allowance for the same underlying capacity. Your in-app receipt
            shows this exact debit on every reply. More model classes are added
            as they go live — never listed before they are servable.
          </p>
        </div>
      </section>

      {/* Comparison table */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title" style={{ marginBottom: "0.75rem" }}>
            What you actually get per month
          </h2>
          <p className="m-subtitle" style={{ maxWidth: "680px", marginBottom: "1.5rem" }}>
            Industry subscriptions use rolling windows, credits, and compute units that don&apos;t map cleanly to token
            counts. Here&apos;s how Zintus compares at each price point.
          </p>
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
                  {["Plan", "Price", "Monthly tokens", "Token transparency"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: h === "Plan" ? "left" : "center",
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
                {COMPARISON.map((row, i) => (
                  <tr
                    key={row.plan}
                    style={{
                      background: row.zintus
                        ? "var(--marketing-accent-soft)"
                        : i % 2 === 0
                          ? "transparent"
                          : "var(--marketing-accent-soft)",
                    }}
                  >
                    <td
                      style={{
                        padding: "0.75rem 1rem",
                        color: row.zintus ? "var(--marketing-accent-light)" : "var(--marketing-text)",
                        fontWeight: row.zintus ? 700 : 500,
                      }}
                    >
                      {row.plan}
                    </td>
                    <td
                      style={{
                        padding: "0.75rem 1rem",
                        textAlign: "center",
                        color: row.zintus ? "var(--marketing-accent-light)" : undefined,
                        fontWeight: row.zintus ? 600 : 400,
                      }}
                    >
                      {row.price}
                    </td>
                    <td
                      style={{
                        padding: "0.75rem 1rem",
                        textAlign: "center",
                        color: row.zintus ? "var(--marketing-accent-light)" : undefined,
                        fontWeight: row.zintus ? 600 : 400,
                      }}
                    >
                      {row.tokens}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "center" }}>
                      <StatusBadge kind={row.transparency}>
                        {row.transparency === "shown" ? "Always shown" : "Hidden"}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Referral */}
      <section className="m-section">
        <div className="m-shell">
          <h2 className="m-title" style={{ marginBottom: "0.75rem" }}>
            Earn by sharing
          </h2>
          <p className="m-subtitle" style={{ maxWidth: "680px", marginBottom: "1.5rem" }}>
            Every paid referral earns you a reward. Pro, Max and Ultra referrals pay 20% of their subscription for 12
            months. Starter referrals pay a flat $15 one-time. <strong>Payouts are coming soon</strong> — referrals
            are tracked from day one, and disbursement (monthly via Stripe) goes live with paid plans.
          </p>
          <div style={{ overflowX: "auto", marginBottom: "1.5rem" }}>
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
                  {["Tier", "Price", "Referral reward"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
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
                {REFERRALS.map((row, i) => (
                  <tr
                    key={row.tier}
                    style={{ background: i % 2 === 0 ? "transparent" : "var(--marketing-accent-soft)" }}
                  >
                    <td style={{ padding: "0.75rem 1rem", color: "var(--marketing-text)", fontWeight: 600 }}>
                      {row.tier}
                    </td>
                    <td style={{ padding: "0.75rem 1rem" }}>{row.price}</td>
                    <td style={{ padding: "0.75rem 1rem" }}>{row.reward}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <a href="/dashboard/referral" className="m-primary-btn" style={{ display: "inline-block" }}>
            Get your referral link
          </a>
        </div>
      </section>

      <Footer />
    </main>
  );
}
