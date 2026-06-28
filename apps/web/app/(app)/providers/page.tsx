"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { QuotaBar } from "@/app/_components/QuotaBar";
import { Icon } from "@/app/_components/Icons";
import { RouteAdvisor } from "./RouteAdvisor";
import {
  deriveProviderStatus,
  statusNeedsAdvice,
  type ProviderStatusDescriptor,
  type ProviderStatusTone,
} from "./status";
import { useAppStore } from "@/lib/app-store";
import { hasEncryptedKeys } from "@/lib/crypto";
import { PROVIDER_BY_ID, PROVIDERS } from "@/lib/providers";
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
    selected,
    passphrase,
    statusMessage,
    validating,
    keys,
    setPassphrase,
    setSelected,
    unlock,
    saveKey,
    removeKey,
    validateKey,
  } = useProviderStatusStore();
  const [draftKey, setDraftKey] = useState("");
  const [saving, setSaving] = useState(false);
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
      <div className="vault-card">
        <label>
          Vault passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder={
              hasEncryptedKeys() ? "Unlock local key vault" : "Create vault passphrase"
            }
          />
        </label>
        <p className="vault-hint">
          Stored in browser with AES-256-GCM. For OS keychain routing, use{" "}
          <code>zintus keys set</code> and run the gateway.
        </p>
      </div>

      <div className="providers-grid">
        {showSkeleton
          ? PROVIDERS.map((provider) => (
              <div
                key={provider.id}
                className="provider-card provider-card-skeleton"
                aria-hidden="true"
              >
                <div className="provider-card-top">
                  <div>
                    <div className="skeleton-line skeleton-line-title" />
                    <div className="skeleton-line skeleton-line-sub" />
                  </div>
                  <div className="skeleton-line skeleton-line-badge" />
                </div>
                <div className="skeleton-line skeleton-line-bar" />
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

              return (
                <button
                  key={provider.id}
                  type="button"
                  className={`provider-card${selectedCard ? " selected" : ""}`}
                  onClick={() => setSelected(provider.id)}
                >
                  <div className="provider-card-top">
                    <div>
                      <div className="provider-card-title">
                        <span
                          className="provider-swatch"
                          style={{ background: provider.color }}
                        />
                        <span>{provider.name}</span>
                      </div>
                      <span className="provider-card-model">
                        {PROVIDER_BY_ID[provider.id].name}
                      </span>
                    </div>
                    <div className="provider-card-badges">
                      <StatusPill desc={provider.status} />
                    </div>
                  </div>

                  <PolicyBadge providerId={provider.id} />
                  <CapabilityBadges providerId={provider.id} />

                  {provider.isLocal ? (
                    <div className="provider-card-quota-label" style={{ marginTop: 10 }}>
                      <span>Local runtime</span>
                      <span>
                        {provider.status.key === "local-running"
                          ? "no API quota"
                          : provider.status.key === "local-stopped"
                            ? "offline"
                            : "—"}
                      </span>
                    </div>
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
                      {provider.quotaLimit != null && provider.quotaLimit > 0 ? (
                        <div
                          className="provider-card-model"
                          style={{ marginTop: 4 }}
                        >
                          {formatTokens(provider.quotaUsed ?? 0)} /{" "}
                          {formatTokens(provider.quotaLimit)} tokens used
                        </div>
                      ) : null}
                      {stats[provider.id] && stats[provider.id]!.attempts > 0 ? (
                        <div className="provider-card-stats">
                          {Math.round(
                            (stats[provider.id]!.successes /
                              stats[provider.id]!.attempts) *
                              100,
                          )}
                          % success · {stats[provider.id]!.avgLatencyMs}ms avg ·{" "}
                          {stats[provider.id]!.attempts} req
                        </div>
                      ) : null}
                      {showAdvisor ? (
                        <RouteAdvisor
                          provider={provider.id}
                          quotaPct={provider.quota}
                        />
                      ) : null}
                    </>
                  ) : (
                    <div className="provider-connect">
                      + Connect API Key
                      {FREE_KEY_URLS[provider.id] ? (
                        <span
                          className="provider-getkey"
                          role="link"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            window.open(
                              FREE_KEY_URLS[provider.id],
                              "_blank",
                              "noopener,noreferrer",
                            );
                          }}
                        >
                          Get free key →
                        </span>
                      ) : null}
                    </div>
                  )}

                  {provider.isLocal &&
                  provider.status.key === "local-stopped" ? (
                    <p className="vault-hint" style={{ marginTop: 8 }}>
                      {localStartHint(provider.id)}
                    </p>
                  ) : null}
                  {provider.isLocal &&
                  provider.status.key === "local-unknown" ? (
                    <p className="vault-hint" style={{ marginTop: 8 }}>
                      Run the gateway to detect a running local runtime.
                    </p>
                  ) : null}
                </button>
              );
            })}
      </div>

      {/* Key priority & fallback — honest "Coming soon" placeholder, NOT a fake
          control. Today Zintus uses one key per provider; prioritized + fallback
          BYOK keys (OpenRouter-style) are on the roadmap. */}
      <div className="vault-card" style={{ opacity: 0.85 }}>
        <div className="provider-card-top" style={{ marginBottom: 6 }}>
          <div className="provider-card-title">
            <Icon name="layers" size={14} />
            <span>Key priority &amp; fallback</span>
          </div>
          <span
            className="provider-chip"
            style={{
              color: "var(--color-text-muted)",
              border: "1px solid var(--c-border)",
            }}
          >
            Coming soon
          </span>
        </div>
        <p className="vault-hint">
          Today each provider uses a single key. Prioritized + fallback BYOK keys
          per provider (OpenRouter-style ordering, with per-key quota) are planned —
          this is a placeholder, not an active control.
        </p>
      </div>

      <div className="vault-card">
        <div className="provider-card-top">
          <div>
            <div className="provider-card-title">
              <span
                className="provider-swatch"
                style={{ background: PROVIDER_BY_ID[selected].color }}
              />
              <span>{PROVIDER_BY_ID[selected].name}</span>
            </div>
            <span className="provider-card-model">
              {MODEL_CAPABILITIES[selected]?.model ?? "API key"}
            </span>
          </div>
          <span
            className={`provider-badge${
              rows.find((row) => row.id === selected)?.hasKey ? " ok" : ""
            }`}
          >
            {rows.find((row) => row.id === selected)?.hasKey
              ? "configured"
              : "needs key"}
          </span>
        </div>
        <CapabilityBadges providerId={selected} />
        <label>
          API key
          <input
            type="password"
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
            placeholder={`Paste your ${PROVIDER_BY_ID[selected].name} API key`}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            onClick={() => void validateKey(selected, draftKey.trim())}
            disabled={validating || saving || !draftKey.trim()}
          >
            {validating ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                Validating…
              </>
            ) : (
              "Validate"
            )}
          </button>
          <button
            type="button"
            disabled={saving || validating || !draftKey.trim()}
            onClick={() => {
              setSaving(true);
              void saveKey(selected, draftKey.trim())
                .then(() => setDraftKey(""))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                Saving…
              </>
            ) : (
              "Save encrypted"
            )}
          </button>
          {keys[selected] ? (
            <button
              type="button"
              className="secondary"
              disabled={saving || validating}
              onClick={() => void removeKey(selected)}
            >
              Remove key
            </button>
          ) : null}
        </div>
        <p className="vault-hint">Stored locally — never sent to any server except the provider.</p>
      </div>

      {statusMessage ? <p className="status-banner">{statusMessage}</p> : null}
    </div>
  );
}
