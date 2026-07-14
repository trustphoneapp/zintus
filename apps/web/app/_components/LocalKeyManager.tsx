"use client";

import { useId, useRef, useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import { hasEncryptedKeys } from "@/lib/crypto";
import { useProviderStatusStore } from "@/lib/store";
import { useFocusTrap } from "@/app/_components/useFocusTrap";

/** The free-tier providers we surface first, with their key-issuance pages. */
const FEATURED: Array<{ id: ProviderId; url: string }> = [
  { id: "gemini", url: "https://aistudio.google.com/apikey" },
  { id: "groq", url: "https://console.groq.com/keys" },
  { id: "cerebras", url: "https://cloud.cerebras.ai/" },
];

/**
 * First-run / unlock flow for local-mode chat. Keys are stored only in the
 * browser's AES-256-GCM vault behind a passphrase — never plaintext, never
 * sent anywhere except (per request) the local gateway. On success the caller
 * retries the pending message.
 */
export function LocalKeyManager({
  open,
  onClose,
  onReady,
}: {
  open: boolean;
  onClose: () => void;
  onReady: () => void;
}) {
  const { setPassphrase, saveKey, unlock, statusMessage } =
    useProviderStatusStore();
  const vaultExists = typeof window !== "undefined" && hasEncryptedKeys();
  const [pass, setPass] = useState("");
  const [drafts, setDrafts] = useState<Partial<Record<ProviderId, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // a11y: trap focus inside the send-blocking dialog, autofocus the first field,
  // Escape dismisses (same as Cancel — never a silent grant), and focus returns
  // to the trigger on close. Hook runs unconditionally (before the early return).
  useFocusTrap(open, cardRef, onClose);

  if (!open) {
    return null;
  }

  const entered = Object.entries(drafts).filter(([, v]) => v && v.trim());
  const canSubmit = pass.trim() && (vaultExists || entered.length > 0);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    setPassphrase(pass.trim());
    try {
      if (vaultExists && entered.length === 0) {
        await unlock();
      } else {
        for (const [id, key] of entered) {
          await saveKey(id as ProviderId, (key as string).trim());
        }
      }
      const keys = useProviderStatusStore.getState().keys;
      if (Object.keys(keys).length > 0) {
        onReady();
      } else {
        setError(
          useProviderStatusStore.getState().statusMessage ??
            "Could not unlock. Check your passphrase.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lkm-overlay" onClick={onClose}>
      <div
        ref={cardRef}
        className="lkm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{vaultExists ? "Unlock your keys" : "Add a key to start"}</h2>
        <p className="lkm-sub">
          {vaultExists
            ? "Enter your vault passphrase to use your saved keys."
            : "Paste a free API key and pick a passphrase. Both stay in this browser."}
        </p>

        {!vaultExists ? (
          <div className="lkm-providers">
            {FEATURED.map(({ id, url }, idx) => (
              <div key={id} className="lkm-provider">
                <div className="lkm-provider-head">
                  <span
                    className="message-provider-dot"
                    style={{ background: PROVIDER_BY_ID[id].color }}
                  />
                  <span className="lkm-provider-name">
                    {PROVIDER_BY_ID[id].name}
                  </span>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lkm-getkey"
                  >
                    Get free key →
                  </a>
                </div>
                <input
                  type="password"
                  placeholder="Paste API key"
                  data-autofocus={idx === 0 ? "" : undefined}
                  value={drafts[id] ?? ""}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [id]: event.target.value }))
                  }
                />
              </div>
            ))}
          </div>
        ) : null}

        <label className="lkm-pass">
          {vaultExists ? "Vault passphrase" : "Create a passphrase"}
          <input
            type="password"
            data-autofocus={vaultExists ? "" : undefined}
            value={pass}
            onChange={(event) => setPass(event.target.value)}
            placeholder="••••••••"
          />
        </label>

        {error ?? statusMessage ? (
          <p className="lkm-error">{error ?? statusMessage}</p>
        ) : null}

        <div className="lkm-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="lkm-primary"
            disabled={!canSubmit || busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? "Saving…" : vaultExists ? "Unlock & send" : "Save & send"}
          </button>
        </div>

        <p className="lkm-foot">Keys never leave your device. Ever.</p>
      </div>
    </div>
  );
}
