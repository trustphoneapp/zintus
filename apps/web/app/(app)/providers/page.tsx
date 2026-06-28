"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { QuotaBar } from "@/app/_components/QuotaBar";
import { RouteOptionsPanel } from "@/app/_components/RouteOptionsPanel";
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
  type TrainingBadge,
} from "@zintus/providers";

const BADGE_LABEL: Record<TrainingBadge, string> = {
  "no-training": "🟢 No training",
  trains: "🔴 May train",
  zdr: "🔵 Zero retention",
  unknown: "⚪ Policy unknown",
};

/** Compact context-window label, e.g. 1_000_000 → "1M", 128_000 → "128K". */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
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
    const gatewayHasKey = Boolean(gateway?.hasKey);
    const vaultHasKey = Boolean(vault?.hasKey);
    // A key is "configured" if the gateway holds it server-side OR the browser
    // vault holds it — vault keys are sent per-request to the loopback gateway,
    // so a vault-only key is just as usable as a server-side one. (Previously,
    // when gateway-connected this read ONLY the gateway, so a key saved in the
    // browser vault showed "No Key" even though chat worked.)
    const hasKey =
      gatewayHasKey ||
      vaultHasKey ||
      provider.id === "ollama" ||
      provider.id === "lmstudio";
    const available = gatewayConnected
      ? Boolean(gateway?.available) || vaultHasKey
      : Boolean(vault?.enabled);
    const inCooldown = gatewayConnected ? Boolean(gateway?.inCooldown) : false;
    // The gateway only tracks quota for keys IT holds. A vault-only key's quota
    // is unknown to the gateway, so show "—" rather than a misleading 0%.
    const quota =
      gatewayConnected && gatewayHasKey
        ? getRemainingQuotaPercent({
            hasKey,
            available,
            quotaUsed: gateway?.quotaUsed,
            quotaLimit: gateway?.quotaLimit,
          })
        : gatewayConnected && vaultHasKey
          ? null
          : hasKey
            ? 100
            : 0;

    return {
      ...provider,
      hasKey,
      available,
      inCooldown,
      quota,
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
                      {provider.inCooldown ? (
                        <span className="provider-chip cooldown">cooldown</span>
                      ) : null}
                      <span
                        className={`provider-badge${provider.hasKey ? " ok" : ""}`}
                      >
                        {provider.hasKey ? "configured" : "no key"}
                      </span>
                    </div>
                  </div>
                  {(() => {
                    const policy = DATA_POLICIES[provider.id];
                    return (
                      <span
                        className={`policy-badge ${policy.badge}`}
                        title={`${policy.note} — ${policy.policyUrl}`}
                      >
                        {BADGE_LABEL[policy.badge]}
                      </span>
                    );
                  })()}
                  <CapabilityBadges providerId={provider.id} />
                  {provider.hasKey ? (
                    <>
                      <div className="provider-card-quota-label">
                        <span>Daily quota</span>
                        <span>
                          {provider.quota == null
                            ? "quota —"
                            : `${pct}% remaining`}
                        </span>
                      </div>
                      <QuotaBar value={pct} color={provider.color} />
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
                      {gatewayConnected &&
                      (provider.inCooldown ||
                        (provider.quota != null && provider.quota <= 20)) ? (
                        <RouteOptionsPanel
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
                </button>
              );
            })}
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
