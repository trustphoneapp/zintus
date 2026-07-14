"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { QuotaBar } from "@/app/_components/QuotaBar";
import { Icon } from "@/app/_components/Icons";
import { RouteAdvisor } from "./RouteAdvisor";
import { KeyManager } from "./KeyManager";
import { MembershipSection } from "./MembershipSection";
import {
  deriveProviderStatus,
  resolveProviderStatusInput,
  statusNeedsAdvice,
  type ProviderStatusDescriptor,
  type ProviderStatusTone,
} from "./status";
import { useAppStore } from "@/lib/app-store";
import { hasEncryptedKeys } from "@/lib/crypto";
import { LOCAL_PROVIDER_IDS, PROVIDERS } from "@/lib/providers";
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

const LOCAL_IDS = LOCAL_PROVIDER_IDS;

const TONE_COLOR: Record<ProviderStatusTone, string> = {
  green: "var(--color-green)",
  warn: "var(--c-warn)",
  danger: "var(--c-danger)",
  muted: "var(--color-text-muted)",
};

/** Training-policy → the 6px row dot (color + short title). */
const TRAINING_DOT: Record<TrainingBadge, { color: string; label: string }> = {
  "no-training": { color: "var(--color-green)", label: "No training" },
  trains: { color: "var(--color-yellow)", label: "May train" },
  zdr: { color: "var(--color-purple-light)", label: "Zero retention" },
  unknown: { color: "var(--color-text-muted)", label: "Policy unknown" },
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

/** Plain mono capability microline for a provider's default model, e.g.
 *  "tools · json · 128k". Missing caps are omitted; context is always last. */
function capMicroline(id: ProviderId): string {
  const caps = MODEL_CAPABILITIES[id];
  if (!caps) return "";
  const parts: string[] = [];
  if (caps.vision) parts.push("vision");
  if (caps.tools) parts.push("tools");
  if (caps.json) parts.push("json");
  parts.push(formatTokens(caps.contextWindow).toLowerCase());
  return parts.join(" · ");
}

/** Compact status: a green "● connected" for live providers, else muted text
 *  ("needs key" / "not running") — mono 10px, honest per the derived status. */
function RowStatus({ desc }: { desc: ProviderStatusDescriptor }) {
  const showDot = desc.key !== "needs-key";
  const color = TONE_COLOR[desc.tone];
  return (
    <span className="pv-status" title={desc.label}>
      {showDot ? (
        <span className="pv-status-dot" style={{ background: color }} />
      ) : null}
      <span style={{ color: showDot ? color : "var(--color-text-muted)" }}>
        {desc.label.toLowerCase()}
      </span>
    </span>
  );
}

/** Where to get a free API key, per provider (used on unconfigured rows). */
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

function ProvidersPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { gatewayConnected, gatewayHealthLoaded, gatewayProviders } =
    useAppStore();
  const setSelectedProvider = useAppStore((s) => s.setSelectedProvider);

  // One-tap local runtime (#22): make the RUNNING runtime the chat provider
  // and jump straight into a conversation with it.
  const useInChat = (id: ProviderId) => {
    setSelectedProvider(id);
    router.push("/chat");
  };
  const {
    providers,
    selected,
    passphrase,
    statusMessage,
    setPassphrase,
    setSelected,
    unlock,
  } = useProviderStatusStore();

  // Row-level "Add key" / "Manage" simply expand that provider's row in place —
  // the key input lives inline in the expanded panel (no scroll-to-bottom).
  const selectAndManage = (id: ProviderId) => {
    setSelected(id);
  };
  const [stats, setStats] = useState<Partial<Record<ProviderId, ProviderStat>>>({});

  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  // Deep-link support (?provider=groq): auto-expand that row once the real
  // rows (not the loading skeleton) are on screen, and scroll it into view —
  // used by the chat composer's pinned-provider notice ("Add key" / "Setup →").
  const deepLinkHandled = useRef(false);
  const rowRefs = useRef<Partial<Record<ProviderId, HTMLDivElement | null>>>({});
  const showSkeleton = gatewayConnected && !gatewayHealthLoaded;
  useEffect(() => {
    if (deepLinkHandled.current || showSkeleton) return;
    const param = searchParams.get("provider");
    if (!param) return;
    const match = PROVIDERS.find((p) => p.id === param);
    if (!match) return;
    deepLinkHandled.current = true;
    setSelected(match.id);
    rowRefs.current[match.id]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [searchParams, showSkeleton, setSelected]);

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
    const { hasKey, available, inCooldown, quotaUsed, quotaLimit } =
      resolveProviderStatusInput({ isLocal, gatewayConnected, gateway, vault });
    // The gateway only tracks quota for keys IT holds. A vault-only key's quota
    // is unknown to the gateway, so leave the raw figures undefined → "—".
    const gatewayTracksQuota = gatewayConnected && gatewayHasKey;
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

  return (
    <div className="screen providers-screen">
      <div
        style={{
          width: "100%",
          maxWidth: 820,
          display: "flex",
          flexDirection: "column",
          gap: 12,
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
              margin: "6px 0 0",
              fontSize: 14,
              lineHeight: 1.5,
              color: "var(--color-text-sub)",
              maxWidth: 600,
            }}
          >
            Bring your own keys. The router only uses providers you&apos;ve
            connected — pricing and limits are yours.
          </p>
        </div>

        {/* Membership — managed routing (no keys) when signed in; a quiet
            sign-in/upgrade upsell otherwise. Sits above the BYOK list; the
            decision + copy live in lib/membership.ts. */}
        <MembershipSection />

        {/* Keys-stay-on-device reassurance — the honesty headline of this page. */}
        <div
          style={{
            display: "flex",
            gap: 9,
            padding: "9px 12px",
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
            <Icon name="plug" size={15} />
          </span>
          <span
            style={{
              fontSize: 12.5,
              lineHeight: 1.5,
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

        {/* Vault passphrase — a single compact inline row (label + input + hint). */}
        <div className="provider-vault-row">
          <div className="provider-vault-row-top">
            <label htmlFor="vault-passphrase" className="provider-eyebrow">
              Vault passphrase
            </label>
            <span className="provider-vault-hint">
              AES-256-GCM in this browser · <code>zintus keys set</code> routes
              the OS keychain
            </span>
          </div>
          <input
            id="vault-passphrase"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder={
              hasEncryptedKeys()
                ? "Unlock local key vault"
                : "Create vault passphrase"
            }
          />
        </div>

        {showSkeleton ? (
          <div className="provider-list" aria-hidden="true">
            {PROVIDERS.map((provider) => (
              <div key={provider.id} className="pv-row">
                <div
                  className="pv-row-toggle"
                  style={{ pointerEvents: "none" }}
                >
                  <div
                    className="skeleton-line"
                    style={{ width: 24, height: 24, borderRadius: 7 }}
                  />
                  <div className="skeleton-line skeleton-line-title" />
                  <div className="skeleton-line skeleton-line-sub" />
                  <div />
                  <div
                    className="skeleton-line skeleton-line-badge"
                    style={{ justifySelf: "end" }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="provider-list">
            {rows.map((provider) => {
              const pct = provider.quota ?? 0;
              const isSelected = selected === provider.id;
              const showAdvisor =
                gatewayConnected &&
                !provider.isLocal &&
                provider.hasKey &&
                (statusNeedsAdvice(provider.status.key) ||
                  (provider.quota != null && provider.quota <= 20));

              const port = PROVIDER_METADATA[provider.id]?.detectPort;
              const model = MODEL_CAPABILITIES[provider.id]?.model;
              // Row model/endpoint microcopy — the default model, or the local
              // runtime endpoint for on-device providers. Never faked.
              const modelLine = provider.isLocal
                ? port
                  ? `localhost:${port}`
                  : "local runtime"
                : model ?? "";

              const dot = provider.isLocal
                ? { color: "var(--color-purple-light)", label: "Local runtime" }
                : TRAINING_DOT[DATA_POLICIES[provider.id].badge];
              const dotTitle = provider.isLocal
                ? DATA_POLICIES[provider.id].note
                : `${dot.label} — ${DATA_POLICIES[provider.id].note}`;

              const freeKeyUrl = FREE_KEY_URLS[provider.id];

              return (
                <div
                  key={provider.id}
                  ref={(el) => {
                    rowRefs.current[provider.id] = el;
                  }}
                  className={`pv-row${isSelected ? " selected" : ""}`}
                >
                  <div className="pv-row-head">
                    <button
                      type="button"
                      className="pv-row-toggle"
                      aria-expanded={isSelected}
                      onClick={() => setSelected(provider.id)}
                    >
                      <span
                        className="pv-chip"
                        aria-hidden="true"
                        style={{
                          background: `color-mix(in oklch, ${provider.color} 18%, transparent)`,
                          color: provider.color,
                        }}
                      >
                        {provider.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="pv-name-cell">
                        <span className="pv-name">{provider.name}</span>
                        <span
                          className="pv-dot"
                          title={dotTitle}
                          style={{ background: dot.color }}
                        />
                      </span>
                      <span className="pv-model" title={modelLine}>
                        {modelLine}
                      </span>
                      <span className="pv-caps">
                        {capMicroline(provider.id)}
                      </span>
                      <RowStatus desc={provider.status} />
                    </button>
                    {!provider.isLocal && provider.hasKey ? (
                      <button
                        type="button"
                        className="pv-action manage"
                        onClick={() => selectAndManage(provider.id)}
                      >
                        Manage
                      </button>
                    ) : !provider.isLocal ? (
                      <button
                        type="button"
                        className="pv-action add"
                        onClick={() => selectAndManage(provider.id)}
                      >
                        Add key
                      </button>
                    ) : null}
                  </div>

                  {/* Expanded panel — all the real wiring, in normal flow. */}
                  {isSelected ? (
                    <div className="pv-panel">
                      {provider.isLocal ? (
                        <>
                          <div className="provider-card-quota-label">
                            <span>Local runtime</span>
                            <span>
                              {provider.status.key === "local-running"
                                ? "no API quota"
                                : provider.status.key === "local-stopped"
                                  ? "offline"
                                  : "—"}
                            </span>
                          </div>
                          {provider.status.key === "local-running" ? (
                            <div className="actions">
                              <button
                                type="button"
                                onClick={() => useInChat(provider.id)}
                              >
                                Use in chat (on-device)
                              </button>
                            </div>
                          ) : null}
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
                      ) : (
                        <>
                          {provider.hasKey ? (
                            <div className="pv-quota">
                              <div className="provider-card-quota-label">
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
                            </div>
                          ) : null}
                          <KeyManager
                            providerId={provider.id}
                            freeKeyUrl={freeKeyUrl}
                          />
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {statusMessage ? (
          <p className="status-banner">{statusMessage}</p>
        ) : null}
      </div>
    </div>
  );
}

// `useSearchParams` (for the `?provider=` deep link) opts this page out of
// static rendering unless it's wrapped in a Suspense boundary — same pattern
// as app/dashboard/cli-callback/page.tsx.
export default function ProvidersPage() {
  return (
    <Suspense fallback={<div className="screen providers-screen" />}>
      <ProvidersPageInner />
    </Suspense>
  );
}
