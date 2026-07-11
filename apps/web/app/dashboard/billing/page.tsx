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
        background: "var(--color-purple-faint)",
        animation: "pulse 1.5s ease-in-out infinite",
      }}
    />
  );
}

/* ─── card wrapper ─────────────────────────────────────────── */
function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "#0d0820",
        border: "1px solid var(--color-border)",
        borderRadius: 12,
        padding: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: "0.85rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--color-text-sub)",
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

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

  const containerStyle: React.CSSProperties = {
    maxWidth: 760,
    margin: "0 auto",
    padding: "2rem 1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
    color: "#f1f5f9",
    fontFamily: "inherit",
  };

  return (
    <div style={containerStyle}>
      <div>
        <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 800 }}>
          Billing &amp; Usage
        </h1>
        <p style={{ margin: "0.25rem 0 0", color: "var(--color-text-sub)", fontSize: "0.9rem" }}>
          Manage your plan, track usage, and share your referral link.
        </p>
      </div>

      {/* Current plan */}
      <Card title="Current plan">
        {loading ? (
          <Skeleton h={24} />
        ) : billing ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: 800 }}>
                {TIER_LABEL[billing.tier]}
              </span>
              <span
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  padding: "0.2rem 0.6rem",
                  borderRadius: 99,
                  background: `${STATUS_COLOR[billing.status]}22`,
                  color: STATUS_COLOR[billing.status],
                  border: `1px solid ${STATUS_COLOR[billing.status]}44`,
                }}
              >
                {billing.status.replace("_", " ")}
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              {billing.tier !== "ultra" && (
                <Link
                  href="/pricing"
                  style={{
                    padding: "0.45rem 1rem",
                    borderRadius: 8,
                    border: "1px solid var(--color-purple)",
                    color: "var(--color-purple-light)",
                    fontSize: "0.85rem",
                    textDecoration: "none",
                    fontWeight: 600,
                  }}
                >
                  Upgrade
                </Link>
              )}
              {billing.tier !== "free" && (
                <button
                  onClick={() => void handlePortal()}
                  disabled={portalLoading}
                  style={{
                    padding: "0.45rem 1rem",
                    borderRadius: 8,
                    border: "1px solid var(--color-border)",
                    background: "transparent",
                    color: "#f1f5f9",
                    fontSize: "0.85rem",
                    cursor: portalLoading ? "wait" : "pointer",
                    fontWeight: 600,
                  }}
                >
                  {portalLoading ? "Loading…" : "Manage subscription"}
                </button>
              )}
            </div>
          </div>
        ) : (
          <p style={{ color: "var(--color-text-sub)", margin: 0 }}>Unable to load plan data.</p>
        )}
      </Card>

      {/* Token usage */}
      <Card title="Token usage">
        {loading ? (
          <>
            <Skeleton h={16} />
            <Skeleton h={10} />
          </>
        ) : usage ? (
          billing?.tier === "free" ? (
            <p style={{ margin: 0, color: "var(--color-text-sub)", fontSize: "0.9rem" }}>
              Unlimited (BYOK — you pay providers directly)
            </p>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.85rem",
                  color: "var(--color-text-sub)",
                }}
              >
                <span>
                  <span style={{ color: "#f1f5f9", fontWeight: 700 }}>
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
                  background: "var(--color-purple-faint)",
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
                        : "var(--color-purple)",
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
              {usage.period_end && (
                <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--color-text-sub)" }}>
                  Resets on {fmtDate(usage.period_end)}
                </p>
              )}
            </>
          )
        ) : (
          <p style={{ color: "var(--color-text-sub)", margin: 0 }}>Unable to load usage data.</p>
        )}
      </Card>

      {/* Referral */}
      <Card title="Referral program">
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
                  background: "var(--color-purple-faint)",
                  padding: "0.4rem 0.75rem",
                  borderRadius: 8,
                  fontSize: "0.85rem",
                  color: "var(--color-purple-light)",
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
                style={{
                  padding: "0.4rem 0.9rem",
                  borderRadius: 8,
                  border: "1px solid var(--color-border)",
                  background: copied ? "var(--color-purple-faint)" : "transparent",
                  color: copied ? "#22c55e" : "#f1f5f9",
                  fontSize: "0.82rem",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  fontWeight: 600,
                  transition: "color 0.2s",
                }}
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
            {referral && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                  gap: "0.75rem",
                }}
              >
                {[
                  { label: "Total referrals", value: referral.total },
                  { label: "Confirmed", value: referral.confirmed },
                  { label: "Pending", value: referral.pending },
                  { label: "Earned", value: formatReferralEarned(referral.earned_cents) },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    style={{
                      background: "var(--color-purple-faint)",
                      borderRadius: 10,
                      padding: "0.75rem 1rem",
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.72rem",
                        color: "var(--color-text-sub)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {label}
                    </p>
                    <p
                      style={{
                        margin: "0.25rem 0 0",
                        fontSize: "1.2rem",
                        fontWeight: 800,
                        color: "#f1f5f9",
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
                  margin: "0.75rem 0 0",
                  fontSize: "0.78rem",
                  color: "var(--color-text-sub)",
                }}
              >
                Referral payouts are coming soon. Commissions accrue once managed-key
                billing is live, but can&apos;t be withdrawn yet.
              </p>
            )}
          </>
        ) : (
          <p style={{ color: "var(--color-text-sub)", margin: 0 }}>No referral data available.</p>
        )}
      </Card>

      {/* Usage history */}
      <Card title="Usage history (last 30 days)">
        {loading ? (
          <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 80 }}>
            {Array.from({ length: 15 }).map((_, i) => (
              <Skeleton key={i} h={((i * 17 + 13) % 60) + 10} w="100%" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <p style={{ color: "var(--color-text-sub)", margin: 0, fontSize: "0.9rem" }}>
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
                    background: "var(--color-purple)",
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

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
