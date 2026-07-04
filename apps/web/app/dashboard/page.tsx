"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  getMe,
  listSessions,
  createSession,
  deleteSession,
  signOut,
  type GatewaySession,
} from "@/lib/cloud";
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
import { useAppStore } from "@/lib/app-store";

/* ─── helpers ──────────────────────────────────────────────── */
function formatLastSeen(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function fmtTokens(n: number): string {
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

/* ─── presentational primitives ────────────────────────────── */
function Card({
  title,
  action,
  children,
  style,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--marketing-surface)",
        border: "1px solid var(--marketing-border)",
        borderRadius: 14,
        padding: "1.25rem 1.35rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.9rem",
        ...style,
      }}
    >
      {(title || action) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
          }}
        >
          {title && (
            <h2
              style={{
                margin: 0,
                fontSize: "0.72rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--marketing-muted)",
              }}
            >
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.7rem",
  color: "var(--marketing-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

/* ─── page ─────────────────────────────────────────────────── */
export default function DashboardPage() {
  const router = useRouter();
  const { gatewaySavings } = useAppStore();

  const [email, setEmail] = useState<string | null>(null);
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [loading, setLoading] = useState(true);

  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageCurrent | null>(null);
  const [history, setHistory] = useState<{ day: string; tokens: number }[]>([]);
  const [referral, setReferral] = useState<ReferralStats | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newSession, setNewSession] = useState<{
    session_id: string;
    gateway_secret: string;
  } | null>(null);
  const [newName, setNewName] = useState("My Gateway");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    const [me, slist] = await Promise.all([getMe(), listSessions()]);
    if (!me.authenticated) {
      router.push("/login");
      return;
    }
    setEmail(me.email ?? null);
    setSessions(slist);
    setLoading(false);
  }, [router]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Billing analytics — fetched once on mount (changes slowly, no polling).
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
    })();
  }, []);

  async function handleAddGateway() {
    setAdding(true);
    const result = await createSession(newName);
    setAdding(false);
    if (result) {
      setNewSession(result);
      await refresh();
    }
  }

  async function handleDelete(sessionId: string) {
    if (!confirm("Delete this gateway session? The home machine will be disconnected.")) return;
    await deleteSession(sessionId);
    await refresh();
  }

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  async function handlePortal() {
    setPortalLoading(true);
    const url = await openBillingPortal();
    setPortalLoading(false);
    if (url) window.location.href = url;
  }

  function handleCopyReferral() {
    if (!billing?.referral_code) return;
    void navigator.clipboard.writeText(
      `https://www.zintus.ai/r/${billing.referral_code}`,
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="auth-container">
        <p className="auth-sub">Loading…</p>
      </div>
    );
  }

  const setupCommand = newSession
    ? `ZINTUS_SESSION_ID=${newSession.session_id} ZINTUS_GATEWAY_SECRET=${newSession.gateway_secret} zintus serve --cloud`
    : "";

  const savedUsd = gatewaySavings?.estimatedUsdSaved ?? null;
  const historyMax = history.reduce((m, d) => Math.max(m, d.tokens), 1);
  const onlineCount = sessions.filter((s) => s.online).length;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1 className="dashboard-title">Zintus Cloud</h1>
        <div className="dashboard-header-right">
          <span className="dashboard-email">{email}</span>
          <a href="/dashboard/billing" className="dashboard-nav-link">Billing</a>
          <a href="/settings" className="dashboard-nav-link">Settings</a>
          <button onClick={handleSignOut} className="dashboard-signout-btn">
            Sign out
          </button>
        </div>
      </header>

      <div className="dashboard-body">
        {/* ── Hero: savings ledger ──────────────────────────── */}
        <div
          style={{
            background:
              "linear-gradient(135deg, color-mix(in oklch, var(--marketing-accent) 22%, var(--marketing-surface)), var(--marketing-surface))",
            border: "1px solid color-mix(in oklch, var(--marketing-accent) 45%, var(--marketing-border))",
            borderRadius: 18,
            padding: "1.75rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <span
            style={{
              fontSize: "0.72rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--marketing-muted)",
            }}
          >
            Savings ledger
          </span>
          <strong
            style={{
              fontSize: "2.85rem",
              fontWeight: 800,
              lineHeight: 1.05,
              color: "var(--marketing-text)",
              letterSpacing: "-0.02em",
            }}
          >
            {savedUsd !== null ? `$${savedUsd.toFixed(2)}` : "—"}
          </strong>
          <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
            {savedUsd !== null
              ? "cumulative, vs paid APIs (estimate — free-tier tokens valued at list pricing)"
              : "Route requests through your Zintus gateway to start tracking what you save vs paid APIs."}
          </p>
        </div>

        {/* ── Usage / quota over time ───────────────────────── */}
        <Card
          title="Usage & quota"
          action={
            usage?.period_end ? (
              <span style={{ fontSize: "0.78rem", color: "var(--marketing-muted)" }}>
                Resets {fmtDate(usage.period_end)}
              </span>
            ) : undefined
          }
        >
          {usage ? (
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
                      {fmtTokens(usage.tokens_used)}
                    </span>
                    {" / "}
                    {usage.tokens_limit ? fmtTokens(usage.tokens_limit) : "∞"} tokens
                  </span>
                  {usage.percent_used !== null && (
                    <span>{usage.percent_used.toFixed(0)}%</span>
                  )}
                </div>
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
                        (usage.percent_used ?? 0) >= 80 ? "#f59e0b" : "var(--marketing-accent)",
                      transition: "width 0.4s ease",
                    }}
                  />
                </div>
                {(usage.percent_used ?? 0) >= 80 && (
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#f59e0b", fontWeight: 600 }}>
                    Warning: you have used {usage.percent_used?.toFixed(0)}% of your monthly
                    quota. Consider upgrading to avoid disruption.
                  </p>
                )}
              </>
            )
          ) : (
            <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.9rem" }}>
              Usage data unavailable.
            </p>
          )}

          {/* 30-day history sparkline */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <span style={labelStyle}>Last 30 days</span>
            {history.length === 0 ? (
              <p style={{ margin: 0, color: "var(--marketing-muted)", fontSize: "0.85rem" }}>
                No usage data yet.
              </p>
            ) : (
              <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 64 }}>
                {history.map((d) => {
                  const pct = historyMax > 0 ? (d.tokens / historyMax) * 100 : 0;
                  return (
                    <div
                      key={d.day}
                      title={`${d.day}: ${fmtTokens(d.tokens)} tokens`}
                      style={{
                        flex: 1,
                        minWidth: 4,
                        height: `${Math.max(pct, 2)}%`,
                        background: "var(--marketing-accent)",
                        borderRadius: "3px 3px 0 0",
                        opacity: 0.8,
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        {/* ── Plan + referral ───────────────────────────────── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1rem",
          }}
        >
          {/* Billing tier */}
          <Card title="Plan">
            {billing ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
                  <span style={{ fontSize: "1.4rem", fontWeight: 800, color: "var(--marketing-text)" }}>
                    {TIER_LABEL[billing.tier]}
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
                    <a href="/pricing" className="session-btn session-btn--primary" style={{ textDecoration: "none" }}>
                      Upgrade
                    </a>
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

          {/* Referral (honest, gated) */}
          <Card title="Referrals">
            {billing?.referral_code ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <code
                    style={{
                      background: "var(--marketing-surface-2)",
                      padding: "0.35rem 0.6rem",
                      borderRadius: 8,
                      fontSize: "0.78rem",
                      color: "var(--marketing-accent)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    zintus.ai/r/{billing.referral_code}
                  </code>
                  <button
                    onClick={handleCopyReferral}
                    className="session-btn"
                    style={{ color: copied ? "#22c55e" : undefined }}
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
                {referral && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))",
                      gap: "0.6rem",
                    }}
                  >
                    {[
                      { label: "Total", value: String(referral.total) },
                      { label: "Confirmed", value: String(referral.confirmed) },
                      { label: "Pending", value: String(referral.pending) },
                      { label: "Earned", value: formatReferralEarned(referral.earned_cents) },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <p style={labelStyle}>{label}</p>
                        <p
                          style={{
                            margin: "0.2rem 0 0",
                            fontSize: "1.05rem",
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
                  <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--marketing-muted)" }}>
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
        </div>

        {/* ── Active sessions ───────────────────────────────── */}
        <Card
          title={`Gateways${sessions.length ? ` · ${onlineCount}/${sessions.length} online` : ""}`}
          action={
            sessions.length > 0 ? (
              <button onClick={() => setShowAddModal(true)} className="dashboard-add-btn">
                + Add Gateway
              </button>
            ) : undefined
          }
          style={{ gap: "0.75rem" }}
        >
          {sessions.length === 0 ? (
            <div className="dashboard-empty">
              <p className="dashboard-empty-text">No gateways connected yet.</p>
              <button onClick={() => setShowAddModal(true)} className="dashboard-add-btn">
                + Add Gateway
              </button>
            </div>
          ) : (
            <div className="dashboard-sessions">
              {sessions.map((s) => (
                <div key={s.id} className="session-card">
                  <div className="session-card-left">
                    <span
                      className={`session-dot ${s.online ? "session-dot--online" : "session-dot--offline"}`}
                      aria-label={s.online ? "online" : "offline"}
                    />
                    <div>
                      <p className="session-name">{s.name}</p>
                      <p className="session-meta">
                        {s.online ? "Online" : `Last seen ${formatLastSeen(s.last_seen)}`}
                      </p>
                    </div>
                  </div>
                  <div className="session-card-actions">
                    <button
                      onClick={() => router.push(`/dashboard/sessions/${s.id}`)}
                      className="session-btn session-btn--primary"
                    >
                      Connect
                    </button>
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="session-btn session-btn--danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Add gateway modal */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => { setShowAddModal(false); setNewSession(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {!newSession ? (
              <>
                <h2 className="modal-title">Add Gateway</h2>
                <label className="modal-label">
                  Name
                  <input
                    className="auth-input"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="My Gateway"
                  />
                </label>
                <div className="modal-actions">
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="session-btn"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddGateway}
                    disabled={adding}
                    className="session-btn session-btn--primary"
                  >
                    {adding ? "Creating…" : "Create"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="modal-title">Gateway created</h2>
                <p className="modal-sub">
                  Run this on your home machine to connect:
                </p>
                <pre className="modal-code">{setupCommand}</pre>
                <p className="modal-warning">
                  ⚠ Save this command — the secret won&apos;t be shown again.
                </p>
                <div className="modal-actions">
                  <button
                    onClick={() => void navigator.clipboard.writeText(setupCommand)}
                    className="session-btn"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => { setShowAddModal(false); setNewSession(null); }}
                    className="session-btn session-btn--primary"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
