"use client";

// MEMBERSHIP section for the Providers page — sits above the BYOK list. Mirrors
// the desktop Models directory's membership presence (managed routing, no keys)
// but in the web app's machined-grey visual language and the vetted
// "Plan: {Tier}" grammar. The pure decision lives in lib/membership.ts; this
// component only fetches billing/usage and renders whatever it returns.

import { useEffect, useState } from "react";
import { QuotaBar } from "@/app/_components/QuotaBar";
import {
  fetchBillingStatus,
  fetchUsageCurrent,
  type BillingStatus,
  type UsageCurrent,
} from "@/lib/billing";
import { membershipView } from "@/lib/membership";

/** Compact token label, e.g. 10_000_000 → "10M", 2_500_000 → "2.5M". */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function MembershipSection() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageCurrent | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([fetchBillingStatus(), fetchUsageCurrent()]).then(
      ([s, u]) => {
        if (!active) return;
        setStatus(s);
        setUsage(u);
        setLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // Until the relay answers we don't know the auth state — render nothing rather
  // than flash the signed-out upsell at a signed-in member (or vice versa).
  if (!loaded) return null;

  const view = membershipView(status, usage);

  if (view.kind === "upsell") {
    return (
      <a
        href={view.href}
        className="pv-membership-upsell"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderRadius: 12,
          border: "0.5px solid var(--c-border)",
          background: "var(--color-surface)",
          textDecoration: "none",
          color: "var(--color-text-sub)",
          fontSize: 13,
        }}
      >
        <span style={{ flex: 1 }}>{view.text}</span>
        <span style={{ color: "var(--color-text-muted)", fontWeight: 600, flexShrink: 0 }}>
          {view.cta} →
        </span>
      </a>
    );
  }

  return (
    <div
      className="pv-membership-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        borderRadius: 12,
        border: "0.5px solid var(--c-border)",
        background: "var(--color-surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text)" }}>
          {view.title}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            padding: "2px 7px",
            borderRadius: 999,
            color: view.pastDue ? "var(--c-warn)" : "var(--color-green)",
            background: view.pastDue
              ? "color-mix(in oklch, var(--c-warn) 14%, transparent)"
              : "color-mix(in oklch, var(--color-green) 14%, transparent)",
          }}
        >
          {view.statusLabel}
        </span>
        <span style={{ flex: 1 }} />
        <a
          href="/dashboard"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--color-text-sub)",
            textDecoration: "none",
            flexShrink: 0,
          }}
        >
          Manage →
        </a>
      </div>

      <span style={{ fontSize: 12.5, color: "var(--color-text-sub)" }}>
        {view.subtitle}
      </span>

      {view.remainingPercent != null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
          <QuotaBar value={view.remainingPercent} color="var(--color-text-sub)" thin />
          {view.limitTokens != null ? (
            <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
              {formatTokens(view.usedTokens ?? 0)} / {formatTokens(view.limitTokens)} plan
              tokens · {view.remainingPercent}% left
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
