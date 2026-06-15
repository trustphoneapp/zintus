"use client";

import { useEffect, useState } from "react";
import Page from "../_components/Page";
import { hasEncryptedKeys } from "@/lib/crypto";
import { useProviderStatusStore } from "@/lib/store";
import { PROVIDER_BY_ID } from "@/lib/providers";

export default function ProvidersPage() {
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

  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  return (
    <Page
      title="Providers"
      description="Manage provider API keys encrypted in localStorage with Web Crypto AES-256-GCM."
    >
      <div className="card">
        <label>
          Vault passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={
              hasEncryptedKeys() ? "Unlock local key vault" : "Create vault passphrase"
            }
          />
        </label>
      </div>

      <div className="provider-grid">
        {providers.map((provider) => {
          const pct = provider.hasKey ? 100 : 0;

          return (
            <article
              key={provider.id}
              className={`card provider-card${selected === provider.id ? " selected" : ""}`}
              onClick={() => setSelected(provider.id)}
            >
              <div className="provider-card-header">
                <h2 style={{ color: provider.color }}>{provider.name}</h2>
                <span className={`badge${provider.hasKey ? " ok" : ""}`}>
                  {provider.hasKey ? "Key saved" : "No key"}
                </span>
              </div>
              <div className="quota-bar" aria-hidden>
                <div
                  className="quota-fill"
                  style={{ width: `${pct}%`, background: provider.color }}
                />
              </div>
              <p className="provider-meta">Priority {provider.priority}</p>
            </article>
          );
        })}
      </div>

      <div className="card">
        <h2>{PROVIDER_BY_ID[selected].name}</h2>
        <label>
          API key
          <input
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="sk-..."
          />
        </label>
        <div className="actions">
          <button
            type="button"
            onClick={() => void validateKey(selected, draftKey.trim())}
            disabled={validating}
          >
            {validating ? "Validating..." : "Validate via worker"}
          </button>
          <button
            type="button"
            onClick={() => {
              void saveKey(selected, draftKey.trim()).then(() => setDraftKey(""));
            }}
          >
            Save encrypted
          </button>
          {keys[selected] ? (
            <button
              type="button"
              className="secondary"
              onClick={() => void removeKey(selected)}
            >
              Remove key
            </button>
          ) : null}
        </div>
      </div>

      {statusMessage ? <p className="status">{statusMessage}</p> : null}
    </Page>
  );
}
