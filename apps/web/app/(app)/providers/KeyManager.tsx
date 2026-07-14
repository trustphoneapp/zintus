"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/app/_components/Icons";
import { useProviderStatusStore } from "@/lib/store";
import { PROVIDER_BY_ID } from "@/lib/providers";
import type { ProviderId } from "@zintus/types";
import {
  combineKeyList,
  moveKey,
  normalizeKeyList,
  removeKeyAt,
  splitKeyList,
} from "./keyOrder";
import { loadFallbacks, saveFallbacks, type FallbackMap } from "./keyVault";

type KeyStatus = "unknown" | "checking" | "valid" | "invalid";
interface KeyEntry {
  value: string;
  status: KeyStatus;
}

/** Validate one key against the SAME endpoint the single-key path uses. */
async function validateOne(providerId: ProviderId, key: string): Promise<boolean> {
  try {
    const response = await fetch("/api/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, key }),
    });
    const result = (await response.json()) as { valid?: boolean };
    return Boolean(result.valid);
  } catch {
    return false;
  }
}

/** Mask a key for display — only ever show the last 4 chars, never the secret. */
function maskKey(value: string): string {
  const tail = value.slice(-4);
  return value.length <= 4 ? "••••" : `••••••${tail}`;
}

const STATUS_COLOR: Record<KeyStatus, string> = {
  unknown: "var(--c-border)",
  checking: "var(--color-text-muted)",
  valid: "var(--color-green)",
  invalid: "var(--c-danger)",
};

const STATUS_LABEL: Record<KeyStatus, string> = {
  unknown: "not tested",
  checking: "checking…",
  valid: "valid",
  invalid: "invalid",
};

/**
 * Ordered BYOK key manager for one provider: primary + fallback keys, reorderable
 * and individually testable. The PRIMARY (first) key is stored in the existing
 * single-key vault (so the gateway BYOK key-push is unchanged); the fallback tail
 * is persisted in the encrypted sidecar (`keyVault`). A single key is just a
 * one-element list — the legacy single-key flow is preserved exactly.
 *
 * No custody: every key is encrypted with the vault passphrase and stays on this
 * device. The local gateway walks this ordered list on a 401/403 auth failure.
 */
export function KeyManager({
  providerId,
  freeKeyUrl,
}: {
  providerId: ProviderId;
  /** When the provider has no key yet, a "Get a free key →" link target. */
  freeKeyUrl?: string;
}) {
  const passphrase = useProviderStatusStore((s) => s.passphrase);
  const primary = useProviderStatusStore((s) => s.keys[providerId] ?? null);
  const saveKey = useProviderStatusStore((s) => s.saveKey);
  const removeKey = useProviderStatusStore((s) => s.removeKey);
  const setStatusMessage = useProviderStatusStore((s) => s.setStatusMessage);

  const [fallbackMap, setFallbackMap] = useState<FallbackMap>({});
  const [entries, setEntries] = useState<KeyEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Load the encrypted fallback tails when the vault unlocks / passphrase changes.
  useEffect(() => {
    let active = true;
    void loadFallbacks(passphrase).then((map) => {
      if (active) setFallbackMap(map);
    });
    return () => {
      active = false;
    };
  }, [passphrase]);

  // Rebuild the visible ordered list whenever the source (provider, primary, or
  // fallback tail) changes, preserving any per-key validation result by value.
  useEffect(() => {
    const list = combineKeyList(primary, fallbackMap[providerId]);
    setEntries((prev) => {
      const prior = new Map(prev.map((e) => [e.value, e.status]));
      return list.map((value) => ({ value, status: prior.get(value) ?? "unknown" }));
    });
  }, [providerId, primary, fallbackMap]);

  // Persist an ordered list: primary → single-key vault, tail → encrypted sidecar.
  async function commit(values: string[]): Promise<void> {
    if (!passphrase) {
      setStatusMessage("Enter a vault passphrase first.");
      return;
    }
    const list = normalizeKeyList(values);
    const { primary: nextPrimary, fallbacks } = splitKeyList(list);
    setBusy(true);
    try {
      if (nextPrimary) {
        await saveKey(providerId, nextPrimary);
      } else {
        await removeKey(providerId);
      }
      const nextMap: FallbackMap = { ...fallbackMap, [providerId]: fallbacks };
      await saveFallbacks(nextMap, passphrase);
      setFallbackMap(nextMap);
      setEntries((prev) => {
        const prior = new Map(prev.map((e) => [e.value, e.status]));
        return list.map((value) => ({
          value,
          status: prior.get(value) ?? "unknown",
        }));
      });
    } finally {
      setBusy(false);
    }
  }

  function addDraft(): void {
    const value = draft.trim();
    if (!value) return;
    void commit([...entries.map((e) => e.value), value]).then(() => setDraft(""));
  }

  function validateDraftThenAdd(): void {
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    void validateOne(providerId, value)
      .then((ok) => {
        if (!ok) {
          setStatusMessage(`${PROVIDER_BY_ID[providerId].name} key looks invalid.`);
        }
        return commit([...entries.map((e) => e.value), value]);
      })
      .then(() => setDraft(""))
      .finally(() => setBusy(false));
  }

  async function validateAt(index: number): Promise<void> {
    const entry = entries[index];
    if (!entry) return;
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, status: "checking" } : e)),
    );
    const ok = await validateOne(providerId, entry.value);
    setEntries((prev) =>
      prev.map((e, i) =>
        i === index ? { ...e, status: ok ? "valid" : "invalid" } : e,
      ),
    );
  }

  const fallbackCount = Math.max(0, entries.length - 1);

  return (
    <div>
      <div className="provider-key-labelrow">
        <label htmlFor={`key-${providerId}`} className="provider-eyebrow">
          {entries.length === 0 ? "Add API key" : "Add fallback key"}
        </label>
        {freeKeyUrl && entries.length === 0 ? (
          <a
            href={freeKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="provider-getkey"
          >
            Get a free key →
          </a>
        ) : null}
      </div>
      <input
        id={`key-${providerId}`}
        className="provider-key-input"
        type="password"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            addDraft();
          }
        }}
        placeholder={
          entries.length === 0
            ? `Paste your ${PROVIDER_BY_ID[providerId].name} API key`
            : "Paste another key (fallback)"
        }
      />
      <div className="actions provider-key-actions">
        <button
          type="button"
          onClick={validateDraftThenAdd}
          disabled={busy || !draft.trim()}
        >
          {busy ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Working…
            </>
          ) : (
            "Validate & add"
          )}
        </button>
        <button
          type="button"
          className="linklike"
          onClick={addDraft}
          disabled={busy || !draft.trim()}
        >
          Add without testing
        </button>
      </div>

      {entries.length > 0 ? (
        <>
          <div
            className="provider-card-quota-label"
            style={{ marginTop: 10, marginBottom: 6 }}
          >
            <span>
              {entries.length} key{entries.length === 1 ? "" : "s"}
            </span>
            <span>
              {fallbackCount === 0
                ? "primary only"
                : `primary + ${fallbackCount} fallback${
                    fallbackCount === 1 ? "" : "s"
                  }`}
            </span>
          </div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {entries.map((entry, index) => (
              <li
                key={`${entry.value}-${index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  border: "0.5px solid var(--c-border)",
                  borderRadius: 8,
                  background: "var(--color-elevated)",
                }}
              >
                <span
                  aria-hidden="true"
                  title={STATUS_LABEL[entry.status]}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    flexShrink: 0,
                    background: STATUS_COLOR[entry.status],
                    border:
                      entry.status === "unknown"
                        ? "1px solid var(--c-border)"
                        : "none",
                  }}
                />
                <span
                  className="provider-chip"
                  style={{
                    flexShrink: 0,
                    color:
                      index === 0
                        ? "var(--color-green)"
                        : "var(--color-text-muted)",
                  }}
                >
                  {index === 0 ? "Primary" : `Fallback ${index}`}
                </span>
                <code
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--color-text-sub)",
                  }}
                >
                  {maskKey(entry.value)}
                </code>
                <span
                  style={{
                    fontSize: 11,
                    color: STATUS_COLOR[entry.status],
                    flexShrink: 0,
                  }}
                >
                  {STATUS_LABEL[entry.status]}
                </span>
                <button
                  type="button"
                  className="sidebar-thread-action"
                  title="Test this key"
                  disabled={entry.status === "checking"}
                  onClick={() => void validateAt(index)}
                >
                  <Icon name="check" size={14} />
                </button>
                <button
                  type="button"
                  className="sidebar-thread-action"
                  title="Move up (higher priority)"
                  disabled={busy || index === 0}
                  onClick={() => void commit(moveKey(entries.map((e) => e.value), index, "up"))}
                >
                  <span style={{ display: "inline-block", transform: "rotate(180deg)" }}>
                    <Icon name="chevron-down" size={14} />
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar-thread-action"
                  title="Move down (lower priority)"
                  disabled={busy || index === entries.length - 1}
                  onClick={() =>
                    void commit(moveKey(entries.map((e) => e.value), index, "down"))
                  }
                >
                  <Icon name="chevron-down" size={14} />
                </button>
                <button
                  type="button"
                  className="sidebar-thread-action"
                  title="Remove this key"
                  disabled={busy}
                  onClick={() =>
                    void commit(removeKeyAt(entries.map((e) => e.value), index))
                  }
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="provider-key-hint">
        Encrypted on this device · first key is primary, retried in order
      </p>
    </div>
  );
}
