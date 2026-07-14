"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchBillingStatus,
  fetchUsageCurrent,
  fetchUsageHistory,
  fetchReferralStats,
  openBillingPortal,
  formatReferralEarned,
  REFERRAL_PAYOUTS_LIVE,
  type BillingStatus,
  type UsageCurrent,
  type ReferralStats,
} from "@/lib/billing";

/* ─── helpers ──────────────────────────────────────────────── */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const TIER_LABEL: Record<BillingStatus["tier"], string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  max: "Max",
  ultra: "Ultra",
};

const STATUS_COLOR: Record<BillingStatus["status"], string> = {
  active: "#22c55e",
  past_due: "#f59e0b",
  cancelled: "#f04438",
};

/* ─── skeleton ─────────────────────────────────────────────── */
function Skeleton({ h = 20, w = "100%" }: { h?: number; w?: string }) {
  return (
    <div
      style={{
        height: h,
        width: w,
        borderRadius: 6,
        background: "var(--marketing-surface-2)",
        animation: "pulse 1.5s ease-in-out infinite",
      }}
    />
  );
}

/* ─── presentational primitives (same machined-card recipe as
   /dashboard — .mk-card supplies bg/border/inset-highlight/shadow,
   .dash-card supplies padding/layout, .dash-eyebrow the mono label). ─── */
function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mk-card dash-card">
      {(title || action) && (
        <div className="dash-card-head">
          {title && <h2 className="dash-eyebrow">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

// Mono, muted eyebrow for inline stat labels (quiet-grey rule — no accent).
const labelStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.66rem",
  fontFamily: "var(--font-mono)",
  color: "var(--marketing-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
};

/* ─── main page ────────────────────────────────────────────── */
export default function BillingPage() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageCurrent | null>(null);
  const [history, setHistory] = useState<{ day: string; tokens: number }[]>([]);
  const [referral, setReferral] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      const [b, u, h, r] = await Promise.all([
        fetchBillingStatus(),
        fetchUsageCurrent(),
        fetchUsageHistory(),
        fetchReferralStats(),
      ]);
      setBilling(b);
      setUsage(u);
      setHistory(h?.history ?? []);
      setReferral(r);
      setLoading(false);
    })();
  }, []);

  async function handlePortal() {
    setPortalLoading(true);
    const url = await openBillingPortal();
    setPortalLoading(false);
    if (url) window.location.href = url;
  }

  function handleCopy() {
    if (!billing?.referral_code) return;
    void navigator.clipboard.writeText(
      `https://www.zintus.ai/r/${billing.referral_code}`
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const historyMax = history.reduce((m, d) => Math.max(m, d.tokens), 1);

  return (
    <div className="dashboard-container">
      <div className="dashboard-body">
        <div>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: "1.4rem",
              fontWeight: 800,
              color: "var(--marketing-text)",
              letterSpacing: "-0.02em",
            }}
          >
            Billing &amp; Usage
          </h1>
          <p style={{ margin: "0.25rem 0 0", color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
            Manage your plan, track usage, and share your referral link.
          </p>
        </div>

        {/* Current plan */}
        <Card title="Plan">
          {loading ? (
            <Skeleton h={24} />
          ) : billing ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap" }}>
                {/* Mirror the desktop AppShell vocabulary: "Plan: {Tier}",
                    free tier tagged BYOK. Capitalized from billing.tier. */}
                <span style={{ fontSize: "1.4rem", fontWeight: 800, color: "var(--marketing-text)" }}>
                  Plan: {TIER_LABEL[billing.tier]}
                  {billing.tier === "free" ? " (BYOK)" : ""}
                </span>
                <span
                  style={{
                    fontSize: "0.68rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    padding: "0.2rem 0.55rem",
                    borderRadius: 99,
                    background: `${STATUS_COLOR[billing.status]}22`,
                    color: STATUS_COLOR[billing.status],
                    border: `1px solid ${STATUS_COLOR[billing.status]}44`,
                  }}
                >
                  {billing.status.replace("_", " ")}
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {billing.tier !== "ultra" && (
                  <Link href="/pricing" className="session-btn session-btn--primary" style={{ textDecoration: "none" }}>
                    Upgrade
                  </Link>
                )}
                {/* Billing-portal gating: only paid tiers can manage a subscription. */}
                {billing.tier !== "free" && (
                  <button
                    onClick={() => void handlePortal()}
                    disabled={portalLoading}
                    className="session-btn"
                  >
                    {portalLoading ? "Loading…" : "Manage subscription"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
              Plan data unavailable.
            </p>
          )}
        </Card>

        {/* Token usage */}
        <Card
          title="Usage & quota"
          action={
            !loading && usage?.period_end ? (
              <span style={{ fontSize: "0.78rem", color: "var(--marketing-muted)" }}>
                Resets {fmtDate(usage.period_end)}
              </span>
            ) : undefined
          }
        >
          {loading ? (
            <>
              <Skeleton h={16} />
              <Skeleton h={10} />
            </>
          ) : usage ? (
            billing?.tier === "free" ? (
              <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
                Unlimited (BYOK — you pay providers directly)
              </p>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.85rem",
                    color: "var(--marketing-muted)",
                  }}
                >
                  <span>
                    <span style={{ color: "var(--marketing-text)", fontWeight: 700 }}>
                      {fmt(usage.tokens_used)}
                    </span>
                    {" / "}
                    {usage.tokens_limit ? fmt(usage.tokens_limit) : "∞"} tokens
                  </span>
                  {usage.percent_used !== null && (
                    <span>{usage.percent_used.toFixed(0)}%</span>
                  )}
                </div>
                {/* Progress bar */}
                <div
                  style={{
                    height: 10,
                    borderRadius: 99,
                    background: "var(--marketing-surface-2)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      borderRadius: 99,
                      width: `${Math.min(usage.percent_used ?? 0, 100)}%`,
                      background:
                        (usage.percent_used ?? 0) >= 80
                          ? "#f59e0b"
                          : "var(--marketing-accent)",
                      transition: "width 0.4s ease",
                    }}
                  />
                </div>
                {(usage.percent_used ?? 0) >= 80 && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: "0.82rem",
                      color: "#f59e0b",
                      fontWeight: 600,
                    }}
                  >
                    Warning: you have used {usage.percent_used?.toFixed(0)}% of your monthly
                    quota. Consider upgrading to avoid disruption.
                  </p>
                )}
              </>
            )
          ) : (
            <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
              Unable to load usage data.
            </p>
          )}
        </Card>

        {/* Referral (honest, gated) */}
        <Card title="Referrals">
          {loading ? (
            <>
              <Skeleton h={16} />
              <Skeleton h={14} w="60%" />
            </>
          ) : billing?.referral_code ? (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  flexWrap: "wrap",
                }}
              >
                <code
                  style={{
                    background: "var(--marketing-surface-2)",
                    padding: "0.4rem 0.75rem",
                    borderRadius: 8,
                    fontSize: "0.85rem",
                    color: "var(--marketing-accent)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  https://www.zintus.ai/r/{billing.referral_code}
                </code>
                <button
                  onClick={handleCopy}
                  className="session-btn"
                  style={{ color: copied ? "#22c55e" : undefined }}
                >
                  {copied ? "Copied!" : "Copy link"}
                </button>
              </div>
              {referral && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: "0.6rem",
                  }}
                >
                  {/* The relay's SUM(CASE …) aggregate returns SQL NULL (not 0)
                      when a user has zero referral rows, so confirmed/pending
                      arrive as null. Coerce to 0 at render. */}
                  {[
                    { label: "Total referrals", value: String(referral.total ?? 0) },
                    { label: "Confirmed", value: String(referral.confirmed ?? 0) },
                    { label: "Pending", value: String(referral.pending ?? 0) },
                    { label: "Earned", value: formatReferralEarned(referral.earned_cents ?? 0) },
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      style={{
                        background: "var(--marketing-surface-2)",
                        borderRadius: 10,
                        padding: "0.75rem 1rem",
                      }}
                    >
                      <p style={labelStyle}>{label}</p>
                      <p
                        style={{
                          margin: "0.25rem 0 0",
                          fontSize: "1.15rem",
                          fontWeight: 800,
                          color: "var(--marketing-text)",
                        }}
                      >
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {referral && !REFERRAL_PAYOUTS_LIVE && (
                <p
                  style={{
                    margin: 0,
                    fontSize: "0.78rem",
                    color: "var(--marketing-muted)",
                  }}
                >
                  Referral payouts are coming soon. Commissions accrue once managed-key
                  billing is live, but can&apos;t be withdrawn yet.
                </p>
              )}
            </>
          ) : (
            <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
              No referral data available.
            </p>
          )}
        </Card>

        {/* Usage history */}
        <Card title="Usage history · last 30 days">
          {loading ? (
            <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 80 }}>
              {Array.from({ length: 15 }).map((_, i) => (
                <Skeleton key={i} h={((i * 17 + 13) % 60) + 10} w="100%" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
              No usage data yet.
            </p>
          ) : (
            <div
              style={{
                display: "flex",
                gap: 3,
                alignItems: "flex-end",
                height: 80,
              }}
            >
              {history.map((d) => {
                const pct = historyMax > 0 ? (d.tokens / historyMax) * 100 : 0;
                return (
                  <div
                    key={d.day}
                    title={`${d.day}: ${fmt(d.tokens)} tokens`}
                    style={{
                      flex: 1,
                      minWidth: 4,
                      height: `${Math.max(pct, 2)}%`,
                      background: "var(--marketing-accent)",
                      borderRadius: "3px 3px 0 0",
                      opacity: 0.8,
                      cursor: "default",
                      transition: "opacity 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.opacity = "1";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.opacity = "0.8";
                    }}
                  />
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
