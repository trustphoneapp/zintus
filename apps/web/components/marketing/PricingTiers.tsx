"use client";

import { useEffect, useState } from "react";
import { InteractiveCard } from "@/components/marketing/InteractiveCard";
import { PAYMENTS_ENABLED, createCheckout } from "@/lib/billing";
import { getMe } from "@/lib/cloud";

// Client island for the pricing page: the tier grid + Ultra bar carry the only
// interactivity on /pricing (Stripe checkout buttons with shared busy/error
// state and a sign-in resume). Isolating it here lets app/pricing/page.tsx stay
// a Server Component, so the hero, trust callouts, rate/comparison/referral
// tables and footer render server-side and never enter the client bundle.

const ACCENT = "var(--marketing-accent)"; // brand accent for card highlight + ribbon
const RED = "#EF4444";

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
    ribbon: "Most popular",
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
  },
];

function Check() {
  // Accent check-chip: accent-soft circle + accent check glyph.
  return (
    <span aria-hidden="true" className="pricing-check">
      ✓
    </span>
  );
}

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

export function PricingTiers() {
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState("");

  async function handleCheckout(tierId: string) {
    // Managed tiers are not for sale. Free/BYOK is unaffected — its CTA is a
    // plain link to /chat and never reaches this function.
    if (!PAYMENTS_ENABLED) return;
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

  // Resume a checkout the user started before signing in. Skipped entirely
  // while payments are off, so /pricing?checkout=pro cannot auto-open checkout
  // without a click.
  useEffect(() => {
    if (!PAYMENTS_ENABLED) return;
    const tier = new URLSearchParams(window.location.search).get("checkout");
    if (tier && PAID_TIERS.includes(tier)) void handleCheckout(tier);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background / border / radius / shadow come from the .mk-card class (machined
  // ladder gradient + inset top-highlight). This only carries layout.
  const cardBase: React.CSSProperties = {
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
    <section className="m-section" style={{ paddingTop: 0 }}>
      <div
        className="m-shell"
        style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", alignItems: "stretch" }}
      >
        {TIERS.filter((t) => t.id !== "ultra").map((tier) => {
          const popular = tier.id === "starter";
          return (
          <InteractiveCard
            key={tier.id}
            tilt
            className={`pricing-tier-card${popular ? " pricing-popular mk-beam" : ""}`}
            style={cardBase}
          >
            {tier.ribbon && (
              <div
                style={{
                  position: "absolute",
                  top: "-0.75rem",
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: tier.ribbonColor ?? ACCENT,
                  // on-accent, not #fff — the accent is white in Obsidian.
                  color: "var(--marketing-on-accent)",
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
                <li
                  key={f}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    fontSize: "0.85rem",
                    color: "var(--marketing-muted)",
                    lineHeight: 1.4,
                  }}
                >
                  <Check />
                  {f}
                </li>
              ))}
            </ul>

            {/* One filled CTA per view: only the featured tier is accent-filled,
                the rest are quiet hairline buttons (accent-budget rule). */}
            {tier.cta.kind === "link" ? (
              <a
                href={tier.cta.href}
                className={`mk-btn ${popular ? "mk-btn-primary" : "mk-btn-secondary"}`}
                style={{ width: "100%" }}
              >
                {tier.cta.label}
              </a>
            ) : (
              <button
                type="button"
                className={`mk-btn ${popular ? "mk-btn-primary" : "mk-btn-secondary"}`}
                style={{ width: "100%" }}
                onClick={() => handleCheckout(tier.id)}
                disabled={!PAYMENTS_ENABLED || busyTier !== null}
              >
                {!PAYMENTS_ENABLED
                  ? "Coming soon"
                  : busyTier === tier.id
                    ? "Opening checkout…"
                    : tier.cta.label}
              </button>
            )}
          </InteractiveCard>
          );
        })}
      </div>
      {checkoutError ? (
        <div className="m-shell" style={{ marginTop: "0.75rem" }}>
          <p style={{ color: RED, fontSize: "0.9rem", margin: 0 }}>{checkoutError}</p>
        </div>
      ) : null}

      {/* Ultra — full-width horizontal bento bar under the grid. */}
      {(() => {
        const ultra = TIERS.find((t) => t.id === "ultra");
        if (!ultra) return null;
        return (
          <div className="m-shell" style={{ marginTop: "1.25rem" }}>
            <InteractiveCard className="pricing-ultra-bar">
              <div className="pricing-ultra-head">
                <p style={{ fontWeight: 700, fontSize: "1rem", color: "var(--marketing-text)", margin: 0 }}>
                  {ultra.badge}
                </p>
                <p style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--marketing-text)", lineHeight: 1.1, margin: "0.25rem 0 0.5rem" }}>
                  {ultra.price}
                  {ultra.per && <span style={{ fontSize: "0.85rem", fontWeight: 400, opacity: 0.6 }}> {ultra.per}</span>}
                </p>
                <span style={pillStyle}>{ultra.pill}</span>
              </div>
              <ul className="pricing-ultra-features">
                {ultra.features.map((f) => (
                  <li key={f}>
                    <Check />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="pricing-ultra-cta">
                <button
                  type="button"
                  className="mk-btn mk-btn-primary"
                  style={{ width: "100%" }}
                  onClick={() => handleCheckout(ultra.id)}
                  disabled={!PAYMENTS_ENABLED || busyTier !== null}
                >
                  {!PAYMENTS_ENABLED
                    ? "Coming soon"
                    : busyTier === ultra.id
                      ? "Opening checkout…"
                      : ultra.cta.label}
                </button>
              </div>
            </InteractiveCard>
          </div>
        );
      })()}
    </section>
  );
}
