"use client";

import { useEffect, useState } from "react";
import { PROVIDER_METADATA } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import { hasEncryptedKeys } from "@/lib/crypto";
import { useProviderStatusStore } from "@/lib/store";
import {
  pushKeyToGateway,
  removeKeyFromGateway,
  fetchGatewayStatus,
  type LocalRuntimes,
} from "@/lib/gateway-key-push";

/** Provider ids that are local runtimes (no key, auto-detected on the host). */
const LOCAL_RUNTIME_IDS: ProviderId[] = ["ollama", "lmstudio"];

/** BYOK providers (everything that takes a pasted API key). */
const BYOK_IDS = (Object.keys(PROVIDER_METADATA) as ProviderId[]).filter(
  (id) => !LOCAL_RUNTIME_IDS.includes(id),
);

const SECURITY_MESSAGE =
  "Stored in your browser's encrypted vault · synced to your home gateway via encrypted relay · never sent to Zintus";

interface AddKeyState {
  provider: ProviderId;
  update: boolean;
}

export default function ProvidersPage() {
  const { passphrase, keys, setPassphrase, unlock } = useProviderStatusStore();

  const [localRuntimes, setLocalRuntimes] = useState<LocalRuntimes | null>(null);
  const [hasGateway, setHasGateway] = useState(false);
  const [addKey, setAddKey] = useState<AddKeyState | null>(null);

  // Unlock the local vault whenever the passphrase changes.
  useEffect(() => {
    void unlock();
  }, [passphrase, unlock]);

  // Poll the resolved gateway status for localRuntimes + key-push capability.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const result = await fetchGatewayStatus();
      if (cancelled) return;
      if (result) {
        setHasGateway(true);
        setLocalRuntimes(result.status.localRuntimes ?? null);
      } else {
        setHasGateway(false);
        setLocalRuntimes(null);
      }
    }
    void load();
    const interval = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="screen providers-screen">
      {/* Vault passphrase — required to encrypt/decrypt local keys. */}
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
        <p className="vault-hint">{SECURITY_MESSAGE}</p>
      </div>

      {/* ── On your system (local runtimes) ─────────────────────────────── */}
      {hasGateway && (
        <section className="byok-section">
          <h2 className="byok-section-title">On your system</h2>
          <p className="byok-section-sub">
            Local runtimes detected on your home machine — free, fully offline.
          </p>
          <div className="byok-list">
            {LOCAL_RUNTIME_IDS.map((id) => {
              const meta = PROVIDER_METADATA[id];
              const runtime =
                id === "ollama"
                  ? localRuntimes?.ollama
                  : localRuntimes?.lmstudio;
              const detected = Boolean(runtime?.detected);
              return (
                <div key={id} className="byok-row">
                  <div className="byok-row-main">
                    <span
                      className={`byok-dot ${detected ? "byok-dot--on" : "byok-dot--off"}`}
                      aria-hidden="true"
                    />
                    <div>
                      <div className="byok-row-title">
                        <span
                          className="provider-swatch"
                          style={{ background: meta.color }}
                        />
                        {meta.name}
                      </div>
                      <p className="byok-row-desc">{meta.description}</p>
                      {detected && runtime?.models && runtime.models.length > 0 && (
                        <p className="byok-row-models">
                          {runtime.models.slice(0, 4).join(", ")}
                          {runtime.models.length > 4
                            ? ` +${runtime.models.length - 4} more`
                            : ""}
                        </p>
                      )}
                    </div>
                  </div>
                  <span
                    className={`byok-status ${detected ? "byok-status--on" : "byok-status--off"}`}
                  >
                    {detected ? "Detected" : "Not detected"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Connect a provider (BYOK) ───────────────────────────────────── */}
      <section className="byok-section">
        <h2 className="byok-section-title">Connect a provider (BYOK)</h2>
        <p className="byok-section-sub">
          Bring your own key. It is encrypted in your browser and pushed to your
          gateway over an encrypted relay.
        </p>
        <div className="byok-list">
          {BYOK_IDS.map((id) => {
            const meta = PROVIDER_METADATA[id];
            const configured = Boolean(keys[id]);
            return (
              <div key={id} className="byok-row">
                <div className="byok-row-main">
                  <span
                    className={`byok-dot ${configured ? "byok-dot--on" : "byok-dot--off"}`}
                    aria-hidden="true"
                  />
                  <div>
                    <div className="byok-row-title">
                      <span
                        className="provider-swatch"
                        style={{ background: meta.color }}
                      />
                      {meta.name}
                    </div>
                    <p className="byok-row-desc">{meta.description}</p>
                    <span
                      className={`byok-policy ${meta.trainsOnData ? "byok-policy--warn" : "byok-policy--safe"}`}
                      title={meta.dataPolicy}
                    >
                      {meta.trainsOnData ? "May train on data" : "No training on data"}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="byok-action"
                  onClick={() => setAddKey({ provider: id, update: configured })}
                >
                  {configured ? "Update key" : "Add key"}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {addKey && (
        <AddKeyModal
          provider={addKey.provider}
          update={addKey.update}
          passphrase={passphrase}
          onClose={() => setAddKey(null)}
        />
      )}
    </div>
  );
}

// ── AddKey modal ─────────────────────────────────────────────────────────────

function AddKeyModal({
  provider,
  update,
  passphrase,
  onClose,
}: {
  provider: ProviderId;
  update: boolean;
  passphrase: string;
  onClose: () => void;
}) {
  const { unlock, removeKey: removeFromVaultUi } = useProviderStatusStore();
  const meta = PROVIDER_METADATA[provider];
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!passphrase) {
      setError("Enter a vault passphrase first.");
      return;
    }
    const key = draftKey.trim();
    if (!key) {
      setError("Paste your API key first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await pushKeyToGateway(provider, key, passphrase);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to add key.");
      return;
    }
    // Refresh the local vault view so the dot/label flip to "configured".
    await unlock();
    onClose();
  }

  async function handleRemove() {
    if (!passphrase) {
      setError("Enter a vault passphrase first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await removeKeyFromGateway(provider, passphrase);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to remove key.");
      return;
    }
    // Keep the in-memory store consistent with the vault we just edited.
    await removeFromVaultUi(provider);
    await unlock();
    onClose();
  }

  return (
    <div className="byok-modal-backdrop" onClick={onClose}>
      <div className="byok-modal" onClick={(e) => e.stopPropagation()}>
        <div className="byok-modal-head">
          <span
            className="provider-swatch"
            style={{ background: meta.color }}
          />
          <h2 className="byok-modal-title">
            {update ? "Update" : "Add"} {meta.name} key
          </h2>
        </div>
        <p className="byok-modal-free">{meta.freeTier}</p>

        <label className="byok-modal-label">
          API key
          <input
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder={meta.keyPrefix ? `${meta.keyPrefix}…` : "API key"}
            autoFocus
          />
        </label>

        <a
          href={meta.keyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="byok-modal-getkey"
        >
          Get free key →
        </a>

        <p className="byok-modal-policy" title={meta.dataPolicy}>
          {meta.dataPolicy}
        </p>

        <p className="byok-modal-security">{SECURITY_MESSAGE}</p>

        {error && <p className="byok-modal-error">{error}</p>}

        <div className="byok-modal-actions">
          {update && (
            <button
              type="button"
              className="byok-modal-btn byok-modal-btn--danger"
              disabled={busy}
              onClick={() => void handleRemove()}
            >
              Remove
            </button>
          )}
          <div className="byok-modal-actions-right">
            <button
              type="button"
              className="byok-modal-btn"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="byok-modal-btn byok-modal-btn--primary"
              disabled={busy}
              onClick={() => void handleSave()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
