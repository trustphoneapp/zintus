import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { PricingTiers } from "@/components/marketing/PricingTiers";
import {
  CLASS_ECONOMICS,
  RATE_TIERS,
  TIER_ORDER,
  planPer1k,
  type ModelClass,
} from "@/lib/economics";

// Server Component. The only interactive surface on this page — the tier grid's
// Stripe checkout buttons (shared busy/error state + sign-in resume) — lives in
// the <PricingTiers> client island. Everything else (hero, trust callouts, the
// rate / comparison / referral tables and footer) is static and renders
// server-side, keeping this route's static markup out of the client bundle.
// (No per-route metadata: the page inherits the root layout's title/description,
// exactly as it did as a client component.)

/* ─── palette ────────────────────────────────────────────── */
const GREEN = "#22C55E";
const RED = "#EF4444";

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
// Rates + tiers + the planPer1k math live in lib/economics.ts (the single
// client-side mirror of workers/relay/src/tiers.ts). This table only names the
// classes that have LIVE managed models and their example models; burn rate and
// min-tier gating come from CLASS_ECONOMICS so no number is hand-copied twice.
const RATE_CLASSES: Array<{ label: string; examples: string; cls: ModelClass }> = [
  { label: "Fast models", examples: "Llama 8B, DeepSeek Flash", cls: "cheap" },
  { label: "Everyday models", examples: "GPT-4o mini", cls: "mid" },
  { label: "Advanced models", examples: "Llama 70B, Kimi K2", cls: "premium" },
  // Live frontier-class model (workers/relay/src/managed.ts: zintus/grok-4.3).
  // CLASS_ECONOMICS gates 'frontier' at Max+ — Starter/Pro show "Upgrade".
  { label: "Frontier models", examples: "Grok 4.3", cls: "frontier" },
];

/* ─── referral rows ──────────────────────────────────────── */
// MUST mirror workers/relay/src/tiers.ts REFERRAL_RULES / REFERRAL_RATE (20%)
// / REFERRAL_MONTHS (12) — every paid tier, including Starter, pays 20%
// recurring for 12 months (there is no flat one-time reward on any tier).
const REFERRALS: Array<{ tier: string; price: string; reward: string }> = [
  { tier: "Starter", price: "$15", reward: "20% recurring · $3.00/mo · $36.00/year" },
  { tier: "Pro", price: "$49", reward: "20% recurring · $9.80/mo · $117.60/year" },
  { tier: "Max", price: "$99", reward: "20% recurring · $19.80/mo · $237.60/year" },
  { tier: "Ultra", price: "$199", reward: "20% recurring · $39.80/mo · $477.60/year" },
];

/* ─── helpers ────────────────────────────────────────────── */
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
export default function PricingPage() {
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

      {/* Tier cards — Free · Starter · Pro · Max + Ultra bar (client island) */}
      <PricingTiers />

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
          <div className="pricing-cost-scroll">
            <table className="pricing-cost-table">
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
                {RATE_CLASSES.map((row) => {
                  const { burn, minTier } = CLASS_ECONOMICS[row.cls];
                  return (
                  <tr key={row.label} style={{ borderBottom: "1px solid var(--marketing-accent-dim)" }}>
                    <td style={{ padding: "0.6rem 0.75rem" }}>
                      <span style={{ fontWeight: 600, color: "var(--marketing-text)" }}>{row.label}</span>
                      <span style={{ color: "var(--marketing-muted)", display: "block", fontSize: "0.8rem" }}>
                        {row.examples}
                      </span>
                    </td>
                    {RATE_TIERS.map((t) => {
                      const locked =
                        TIER_ORDER.indexOf(t.id) < TIER_ORDER.indexOf(minTier as (typeof TIER_ORDER)[number]);
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
                          {locked ? "Upgrade" : `−${planPer1k(burn, t).toLocaleString()} / 1K`}
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
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
            Every paid referral — Starter, Pro, Max, and Ultra — earns you 20% of their subscription, paid
            monthly, for 12 months. <strong>Payouts are coming soon</strong> — referrals
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
          <a href="/dashboard/referral" className="mk-btn mk-btn-primary">
            Get your referral link
          </a>
        </div>
      </section>

      <Footer />
    </main>
  );
}
