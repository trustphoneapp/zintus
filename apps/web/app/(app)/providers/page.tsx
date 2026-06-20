"use client";

import { useEffect, useState } from "react";
import { QuotaBar } from "@/app/_components/QuotaBar";
import { useAppStore } from "@/lib/app-store";
import { hasEncryptedKeys } from "@/lib/crypto";
import { PROVIDER_BY_ID, PROVIDERS } from "@/lib/providers";
import { getRemainingQuotaPercent } from "@/lib/quota";
import { useProviderStatusStore } from "@/lib/store";

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

  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  const rows = PROVIDERS.map((provider) => {
    const gateway = gatewayProviders.find((item) => item.id === provider.id);
    const vault = providers.find((item) => item.id === provider.id);
    const hasKey = gatewayConnected
      ? Boolean(gateway?.hasKey)
      : Boolean(vault?.hasKey) ||
        provider.id === "ollama" ||
        provider.id === "lmstudio";
    const available = gatewayConnected
      ? Boolean(gateway?.available)
      : Boolean(vault?.enabled);
    const inCooldown = gatewayConnected ? Boolean(gateway?.inCooldown) : false;
    const quota = gatewayConnected
      ? getRemainingQuotaPercent({
          hasKey,
          available,
          quotaUsed: gateway?.quotaUsed,
          quotaLimit: gateway?.quotaLimit,
        })
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
                    </>
                  ) : (
                    <div className="provider-connect">+ Connect API Key</div>
                  )}
                </button>
              );
            })}
      </div>

      <div className="vault-card">
        <h2>{PROVIDER_BY_ID[selected].name}</h2>
        <label>
          API key
          <input
            type="password"
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
            placeholder="sk-..."
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
