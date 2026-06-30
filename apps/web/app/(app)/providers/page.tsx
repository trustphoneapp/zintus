"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { QuotaBar } from "@/app/_components/QuotaBar";
import { Icon } from "@/app/_components/Icons";
import { RouteAdvisor } from "./RouteAdvisor";
import { KeyManager } from "./KeyManager";
import {
  deriveProviderStatus,
  statusNeedsAdvice,
  type ProviderStatusDescriptor,
  type ProviderStatusTone,
} from "./status";
import { useAppStore } from "@/lib/app-store";
import { hasEncryptedKeys } from "@/lib/crypto";
import { PROVIDERS } from "@/lib/providers";
import { getRemainingQuotaPercent } from "@/lib/quota";
import { useProviderStatusStore } from "@/lib/store";
import { fetchGatewayTraces } from "@/lib/gateway";
import type { ProviderId } from "@zintus/types";
import {
  DATA_POLICIES,
  MODEL_CAPABILITIES,
  PROVIDER_METADATA,
  type TrainingBadge,
} from "@zintus/providers";

const LOCAL_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "ollama",
  "lmstudio",
]);

const BADGE_LABEL: Record<TrainingBadge, string> = {
  "no-training": "🟢 No training",
  trains: "🔴 May train",
  zdr: "🔵 Zero retention",
  unknown: "⚪ Policy unknown",
};

const TONE_COLOR: Record<ProviderStatusTone, string> = {
  green: "var(--color-green)",
  warn: "var(--c-warn)",
  danger: "var(--c-danger)",
  muted: "var(--color-text-muted)",
};

/** Compact token label, e.g. 1_000_000 → "1M", 128_000 → "128K". */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** How to start each local runtime, surfaced when it isn't detected. */
function localStartHint(id: ProviderId): string {
  const port = PROVIDER_METADATA[id]?.detectPort;
  if (id === "ollama") {
    return `Start it: run \`ollama serve\`${port ? ` (port ${port})` : ""}.`;
  }
  return `Start it: open LM Studio → Local Server${port ? ` (port ${port})` : ""}.`;
}

const CAP_ON: CSSProperties = {
  color: "var(--color-green)",
  border: "1px solid color-mix(in oklch, var(--color-green) 35%, transparent)",
  background: "color-mix(in oklch, var(--color-green) 12%, transparent)",
};
const CAP_OFF: CSSProperties = {
  color: "var(--color-text-muted)",
  border: "1px solid var(--c-border)",
  background: "transparent",
  opacity: 0.6,
};
const CAP_CTX: CSSProperties = {
  color: "var(--color-text-sub)",
  border: "1px solid var(--c-border)",
  background: "transparent",
};

/** Compact context-window label, e.g. 1_000_000 → "1M", 128_000 → "128K". */
function formatContext(tokens: number): string {
  return formatTokens(tokens);
}

/** OpenRouter-style capability chips for a provider's default model. */
function CapabilityBadges({ providerId }: { providerId: ProviderId }) {
  const caps = MODEL_CAPABILITIES[providerId];
  if (!caps) return null;
  const jsonTitle =
    caps.structuredOutput === "json_schema"
      ? "Structured output: schema-constrained (guaranteed)"
      : caps.structuredOutput === "json_object"
        ? "Structured output: JSON mode"
        : "No native structured output";
  const items: Array<{ label: string; on: boolean; title: string }> = [
    { label: "Vision", on: caps.vision, title: "Accepts image input" },
    { label: "Tools", on: caps.tools, title: "Supports tool / function calling" },
    { label: "JSON", on: caps.json, title: jsonTitle },
  ];
  return (
    <div
      className="provider-card-caps"
      style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}
    >
      {items.map((item) => (
        <span
          key={item.label}
          className="provider-chip"
          style={item.on ? CAP_ON : CAP_OFF}
          title={item.title}
        >
          {item.label}
        </span>
      ))}
      <span
        className="provider-chip"
        style={CAP_CTX}
        title={`${caps.contextWindow.toLocaleString()} token context window · ${caps.model}`}
      >
        {formatContext(caps.contextWindow)} ctx
      </span>
    </div>
  );
}

/** Tinted status pill — the cockpit's headline "is this provider usable?" signal. */
function StatusPill({ desc }: { desc: ProviderStatusDescriptor }) {
  const color = TONE_COLOR[desc.tone];
  return (
    <span
      className="provider-chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        color,
        border: `1px solid color-mix(in oklch, ${color} 35%, transparent)`,
        background: `color-mix(in oklch, ${color} 12%, transparent)`,
      }}
      title={desc.label}
    >
      <Icon name={desc.icon} size={12} />
      {desc.label}
    </span>
  );
}

/** Data-policy badge + a link to the provider's own policy (the source of truth). */
function PolicyBadge({ providerId }: { providerId: ProviderId }) {
  const policy = DATA_POLICIES[providerId];
  const isLocal = policy.policyUrl === "local";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
      <span
        className={`policy-badge ${policy.badge}`}
        title={policy.note}
      >
        {BADGE_LABEL[policy.badge]}
      </span>
      {isLocal ? (
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          on-device
        </span>
      ) : (
        <a
          href={policy.policyUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          style={{
            fontSize: 11,
            color: "var(--color-text-muted)",
            textDecoration: "underline",
          }}
          title={`${policy.dataRetention} — opens the provider's policy`}
        >
          policy ↗
        </a>
      )}
    </div>
  );
}

/** Compact, design-matched policy pill: short label + tone, no link clutter. */
const POLICY_PILL: Record<TrainingBadge, { label: string; color: string }> = {
  "no-training": { label: "No training", color: "var(--color-green)" },
  trains: { label: "May train", color: "var(--color-yellow)" },
  zdr: { label: "Zero retention", color: "var(--color-purple-light)" },
  unknown: { label: "Policy unknown", color: "var(--color-text-muted)" },
};

function PolicyPill({
  providerId,
  isLocal,
}: {
  providerId: ProviderId;
  isLocal: boolean;
}) {
  const policy = DATA_POLICIES[providerId];
  const pill = isLocal
    ? { label: "Local", color: "var(--color-purple-light)" }
    : POLICY_PILL[policy.badge];
  return (
    <span
      title={policy.note}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 9px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        color: pill.color,
        background: `color-mix(in oklch, ${pill.color} 14%, transparent)`,
      }}
    >
      {pill.label}
    </span>
  );
}

/** Tinted, lettered avatar in the provider's own hue — the row's identity anchor. */
function ProviderAvatar({ name, color }: { name: string; color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 40,
        height: 40,
        borderRadius: 11,
        flexShrink: 0,
        fontWeight: 700,
        fontSize: 16,
        background: `color-mix(in oklch, ${color} 18%, transparent)`,
        color,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Mask a key for display — only ever show the last 4 chars, never the secret. */
function maskKeyTail(value: string): string {
  const tail = value.slice(-4);
  return value.length <= 4 ? "••••" : `••••${tail}`;
}

/** Where to get a free API key, per provider (used on unconfigured cards). */
const FREE_KEY_URLS: Partial<Record<ProviderId, string>> = {
  cerebras: "https://cloud.cerebras.ai/",
  groq: "https://console.groq.com/keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  cohere: "https://dashboard.cohere.com/api-keys",
  mistral: "https://console.mistral.ai/api-keys/",
  deepseek: "https://platform.deepseek.com/api_keys",
  fireworks: "https://fireworks.ai/account/api-keys",
  xai: "https://console.x.ai/",
  huggingface: "https://huggingface.co/settings/tokens",
};

interface ProviderStat {
  attempts: number;
  successes: number;
  avgLatencyMs: number;
}

export default function ProvidersPage() {
  const { gatewayConnected, gatewayHealthLoaded, gatewayProviders } =
    useAppStore();
  const {
    providers,
    keys,
    selected,
    passphrase,
    statusMessage,
    setPassphrase,
    setSelected,
    unlock,
  } = useProviderStatusStore();

  // Row-level "Add key" / "Manage" simply expand that provider's card in place —
  // the key input lives inline in the expanded row (no scroll-to-bottom).
  const selectAndManage = (id: ProviderId) => {
    setSelected(id);
  };
  const [stats, setStats] = useState<Partial<Record<ProviderId, ProviderStat>>>({});

  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  // Aggregate per-provider success rate + avg latency from recent traces.
  useEffect(() => {
    if (!gatewayConnected) {
      setStats({});
      return;
    }
    let active = true;
    const load = async () => {
      const traces = await fetchGatewayTraces(50);
      if (!active) return;
      const acc: Partial<Record<ProviderId, ProviderStat & { latencySum: number }>> = {};
      for (const trace of traces) {
        for (const attempt of trace.attempts) {
          const id = attempt.providerId;
          const cur = acc[id] ?? { attempts: 0, successes: 0, avgLatencyMs: 0, latencySum: 0 };
          cur.attempts += 1;
          if (attempt.status !== "fail") cur.successes += 1;
          cur.latencySum += attempt.latencyMs ?? 0;
          acc[id] = cur;
        }
      }
      const out: Partial<Record<ProviderId, ProviderStat>> = {};
      for (const [id, v] of Object.entries(acc)) {
        out[id as ProviderId] = {
          attempts: v.attempts,
          successes: v.successes,
          avgLatencyMs: v.attempts > 0 ? Math.round(v.latencySum / v.attempts) : 0,
        };
      }
      setStats(out);
    };
    void load();
    const interval = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [gatewayConnected]);

  const rows = PROVIDERS.map((provider) => {
    const gateway = gatewayProviders.find((item) => item.id === provider.id);
    const vault = providers.find((item) => item.id === provider.id);
    const isLocal = LOCAL_IDS.has(provider.id);
    const gatewayHasKey = Boolean(gateway?.hasKey);
    const vaultHasKey = Boolean(vault?.hasKey);
    // A key is "configured" if the gateway holds it server-side OR the browser
    // vault holds it — vault keys are sent per-request to the loopback gateway,
    // so a vault-only key is just as usable as a server-side one.
    const hasKey = gatewayHasKey || vaultHasKey || isLocal;
    const available = gatewayConnected
      ? Boolean(gateway?.available) || vaultHasKey
      : Boolean(vault?.enabled);
    const inCooldown = gatewayConnected ? Boolean(gateway?.inCooldown) : false;
    // The gateway only tracks quota for keys IT holds. A vault-only key's quota
    // is unknown to the gateway, so leave the raw figures undefined → "—".
    const gatewayTracksQuota = gatewayConnected && gatewayHasKey;
    const quotaUsed = gatewayTracksQuota ? gateway?.quotaUsed : undefined;
    const quotaLimit = gatewayTracksQuota ? gateway?.quotaLimit : undefined;
    const quota = gatewayTracksQuota
      ? getRemainingQuotaPercent({
          hasKey,
          available,
          quotaUsed,
          quotaLimit,
        })
      : gatewayConnected && vaultHasKey
        ? null
        : isLocal
          ? null
          : hasKey
            ? 100
            : 0;

    const status = deriveProviderStatus({
      isLocal,
      gatewayConnected,
      hasKey,
      available,
      inCooldown,
      quotaUsed,
      quotaLimit,
    });

    return {
      ...provider,
      isLocal,
      hasKey,
      available,
      inCooldown,
      quota,
      quotaUsed,
      quotaLimit,
      status,
    };
  });

  const showSkeleton = gatewayConnected && !gatewayHealthLoaded;

  return (
    <div className="screen providers-screen">
      <div
        style={{
          width: "100%",
          maxWidth: 820,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Page intro — matches the design's title + bring-your-own-keys promise. */}
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.01em",
            }}
          >
            Providers &amp; keys
          </h1>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: 14.5,
              lineHeight: 1.6,
              color: "var(--color-text-sub)",
              maxWidth: 600,
            }}
          >
            Bring your own keys. The router only uses providers you&apos;ve
            connected — pricing and limits are yours.
          </p>
        </div>

        {/* Keys-stay-on-device reassurance — the honesty headline of this page. */}
        <div
          style={{
            display: "flex",
            gap: 9,
            padding: "12px 14px",
            borderRadius: 12,
            background: "color-mix(in oklch, var(--color-green) 9%, transparent)",
            border:
              "0.5px solid color-mix(in oklch, var(--color-green) 28%, transparent)",
          }}
        >
          <span
            style={{
              color: "var(--color-green)",
              flexShrink: 0,
              marginTop: 1,
              display: "inline-flex",
            }}
          >
            <Icon name="plug" size={17} />
          </span>
          <span
            style={{
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--color-text-sub)",
            }}
          >
            <strong style={{ color: "var(--color-text)" }}>
              Keys stay on your device.
            </strong>{" "}
            They&apos;re stored in your gateway&apos;s keychain and sent
            provider-to-provider — never through Zintus servers.
          </span>
        </div>

        <div className="vault-card">
          <label>
            Vault passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={
                hasEncryptedKeys()
                  ? "Unlock local key vault"
                  : "Create vault passphrase"
              }
            />
          </label>
          <p className="vault-hint">
            Stored in browser with AES-256-GCM. For OS keychain routing, use{" "}
            <code>zintus keys set</code> and run the gateway.
          </p>
        </div>

        <div
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          {showSkeleton
            ? PROVIDERS.map((provider) => (
                <div
                  key={provider.id}
                  className="provider-card provider-card-skeleton"
                  aria-hidden="true"
                  style={{ display: "flex", alignItems: "center", gap: 14 }}
                >
                  <div
                    className="skeleton-line"
                    style={{ width: 40, height: 40, borderRadius: 11 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div className="skeleton-line skeleton-line-title" />
                    <div className="skeleton-line skeleton-line-sub" />
                  </div>
                  <div className="skeleton-line skeleton-line-badge" />
                </div>
              ))
            : rows.map((provider) => {
                const pct = provider.quota ?? 0;
                const selectedCard = selected === provider.id;
                const showAdvisor =
                  gatewayConnected &&
                  !provider.isLocal &&
                  provider.hasKey &&
                  (statusNeedsAdvice(provider.status.key) ||
                    (provider.quota != null && provider.quota <= 20));

                // Honest sub-line: masked key only when this device actually holds
                // it; otherwise the default model / runtime endpoint — never faked.
                const port = PROVIDER_METADATA[provider.id]?.detectPort;
                const localKey = keys[provider.id];
                const model = MODEL_CAPABILITIES[provider.id]?.model;
                let sub: string;
                if (provider.isLocal) {
                  sub = port ? `localhost:${port}` : "local runtime";
                } else {
                  const parts: string[] = [];
                  if (localKey) parts.push(maskKeyTail(localKey));
                  else if (provider.hasKey) parts.push("key on gateway");
                  if (model) parts.push(model);
                  sub = parts.length > 0 ? parts.join(" · ") : "Bring your own key";
                }

                return (
                  <div
                    key={provider.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedCard}
                    className={`provider-card${selectedCard ? " selected" : ""}`}
                    style={{ padding: "15px 16px" }}
                    onClick={() => setSelected(provider.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(provider.id);
                      }
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                      }}
                    >
                      <ProviderAvatar
                        name={provider.name}
                        color={provider.color}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 9,
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontSize: 14.5, fontWeight: 700 }}>
                            {provider.name}
                          </span>
                          <PolicyPill
                            providerId={provider.id}
                            isLocal={provider.isLocal}
                          />
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 12,
                            color: "var(--color-text-muted)",
                            fontFamily: "var(--font-mono)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {sub}
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          flexShrink: 0,
                        }}
                      >
                        <StatusPill desc={provider.status} />
                        {!provider.isLocal && provider.hasKey ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              selectAndManage(provider.id);
                            }}
                            style={{
                              padding: "7px 13px",
                              borderRadius: 9,
                              border: "0.5px solid var(--c-border-strong)",
                              background: "var(--color-elevated)",
                              color: "var(--color-text-sub)",
                              fontSize: 12.5,
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            Manage
                          </button>
                        ) : !provider.isLocal ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              selectAndManage(provider.id);
                            }}
                            style={{
                              padding: "8px 15px",
                              borderRadius: 9,
                              border: "none",
                              background: "var(--c-accent)",
                              color: "var(--c-accent-contrast)",
                              fontSize: 12.5,
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            Add key
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Expanded detail — all the real wiring, surfaced on select. */}
                    {selectedCard ? (
                      <div style={{ marginTop: 12 }}>
                        <PolicyBadge providerId={provider.id} />
                        <CapabilityBadges providerId={provider.id} />

                        {!provider.isLocal && !provider.hasKey &&
                        FREE_KEY_URLS[provider.id] ? (
                          <button
                            type="button"
                            className="provider-getkey"
                            onClick={(event) => {
                              event.stopPropagation();
                              window.open(
                                FREE_KEY_URLS[provider.id],
                                "_blank",
                                "noopener,noreferrer",
                              );
                            }}
                            style={{
                              marginTop: 10,
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                            }}
                          >
                            Get a free key →
                          </button>
                        ) : null}

                        {provider.isLocal ? (
                          <>
                            <div
                              className="provider-card-quota-label"
                              style={{ marginTop: 10 }}
                            >
                              <span>Local runtime</span>
                              <span>
                                {provider.status.key === "local-running"
                                  ? "no API quota"
                                  : provider.status.key === "local-stopped"
                                    ? "offline"
                                    : "—"}
                              </span>
                            </div>
                            {provider.status.key === "local-stopped" ? (
                              <p className="vault-hint" style={{ marginTop: 8 }}>
                                {localStartHint(provider.id)}
                              </p>
                            ) : null}
                            {provider.status.key === "local-unknown" ? (
                              <p className="vault-hint" style={{ marginTop: 8 }}>
                                Run the gateway to detect a running local runtime.
                              </p>
                            ) : null}
                          </>
                        ) : provider.hasKey ? (
                          <>
                            <div
                              className="provider-card-quota-label"
                              style={{ marginTop: 10 }}
                            >
                              <span>Daily quota</span>
                              <span>
                                {provider.quota == null
                                  ? "quota —"
                                  : `${pct}% remaining`}
                              </span>
                            </div>
                            <QuotaBar value={pct} color={provider.color} />
                            {provider.quotaLimit != null &&
                            provider.quotaLimit > 0 ? (
                              <div
                                className="provider-card-model"
                                style={{ marginTop: 4 }}
                              >
                                {formatTokens(provider.quotaUsed ?? 0)} /{" "}
                                {formatTokens(provider.quotaLimit)} tokens used
                              </div>
                            ) : null}
                            {stats[provider.id] &&
                            stats[provider.id]!.attempts > 0 ? (
                              <div className="provider-card-stats">
                                {Math.round(
                                  (stats[provider.id]!.successes /
                                    stats[provider.id]!.attempts) *
                                    100,
                                )}
                                % success · {stats[provider.id]!.avgLatencyMs}ms
                                avg · {stats[provider.id]!.attempts} req
                              </div>
                            ) : null}
                            {showAdvisor ? (
                              <RouteAdvisor
                                provider={provider.id}
                                quotaPct={provider.quota}
                              />
                            ) : null}
                          </>
                        ) : null}

                        {/* Key input, inline in the expanded row (add / manage
                            keys right here — no jump to a separate card). The
                            stopPropagation keeps clicks inside the form from
                            re-toggling the card. */}
                        {!provider.isLocal ? (
                          <div
                            className="provider-keymanager-inline"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <KeyManager providerId={provider.id} />
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
        </div>

        {/* Key priority & fallback — manageable here in the cockpit, end to end.
          The selected provider's card below holds an ORDERED key list (primary +
          fallbacks): add, reorder, test, and remove keys. The first key is the
          primary; the local gateway walks the list on an auth (401/403) failure
          before abandoning the provider (OpenRouter-style). No custody — keys are
          encrypted on this device and never sent anywhere except your gateway. */}
      <div className="vault-card">
        <div className="provider-card-top" style={{ marginBottom: 6 }}>
          <div className="provider-card-title">
            <Icon name="layers" size={14} />
            <span>Key priority &amp; fallback</span>
          </div>
          <span className="provider-badge ok">Active</span>
        </div>
        <p className="vault-hint">
          Each provider keeps an ordered key list — expand a provider above to add
          a primary plus any number of fallbacks. On an authentication failure your
          local gateway automatically retries the next key in priority order before
          failing over to another provider. Keys are never sent anywhere except your
          own gateway.
        </p>
      </div>

        {statusMessage ? (
          <p className="status-banner">{statusMessage}</p>
        ) : null}
      </div>
    </div>
  );
}
