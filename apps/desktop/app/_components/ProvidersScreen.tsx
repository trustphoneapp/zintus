"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_IDS } from "@zintus/types";
import { deleteKey, getKey, isTauri, setKey } from "@/lib/tauri";
import { validateProviderKey } from "@/lib/gateway";
import { useProviderStatusStore } from "@/lib/store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { QuotaBar } from "./QuotaBar";
import { RouteOptionsPanel } from "./RouteOptionsPanel";

export default function ProvidersScreen() {
  const router = useRouter();
  const { providers, statusMessage, refresh, setStatusMessage, setSelectedProvider } =
    useProviderStatusStore();
  const [selected, setSelected] = useState<ProviderId>("groq");
  const [keyInput, setKeyInput] = useState("");
  const [testing, setTesting] = useState<string | null>(null);

  /** Report a three-state test result: valid / invalid / could-not-test. */
  const reportTest = (id: ProviderId, r: { ok: boolean; valid?: boolean; error?: string }) => {
    if (!r.ok) setStatusMessage(`Could not test ${id} key: ${r.error}`);
    else if (r.valid) setStatusMessage(`✓ ${id} key is valid`);
    else setStatusMessage(`✗ ${id} key was rejected by the provider`);
  };

  const testDraft = async () => {
    if (!keyInput.trim()) return;
    setTesting("draft");
    try {
      reportTest(selected, await validateProviderKey(selected, keyInput.trim()));
    } finally {
      setTesting(null);
    }
  };

  const testStored = async (id: ProviderId) => {
    setTesting(id);
    try {
      const key = await getKey(id);
      if (!key) {
        setStatusMessage(`No key stored for ${id}.`);
        return;
      }
      reportTest(id, await validateProviderKey(id, key));
    } finally {
      setTesting(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = async () => {
    if (!keyInput.trim()) {
      return;
    }
    try {
      await setKey(selected, keyInput.trim());
      setKeyInput("");
      setStatusMessage(`Saved key for ${selected}`);
      await refresh();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to save key");
    }
  };

  const removeKey = async (id: ProviderId) => {
    await deleteKey(id);
    setStatusMessage(`Removed key for ${id}`);
    await refresh();
  };

  const revealMasked = async (id: ProviderId) => {
    const key = await getKey(id);
    setStatusMessage(key ? `${id}: ${key.slice(0, 4)}…${key.slice(-4)}` : `No key for ${id}`);
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Providers</h1>
        <p style={{ fontSize: 14, color: "var(--color-text-sub)" }}>
          API keys are stored in your OS keyring (Keychain, Credential Manager,
          or Secret Service) under the same `zintus` service the local gateway
          reads.
          {!isTauri() && " Run `bun tauri dev` for keyring access."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add API key</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value as ProviderId)}
              style={{ width: "auto", minWidth: 140 }}
            >
              {PROVIDER_IDS.filter((id) => id !== "ollama" && id !== "lmstudio").map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <Input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-..."
              style={{ maxWidth: 320, flex: 1 }}
            />
            <Button type="button" onClick={() => void saveKey()}>
              Save to keyring
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={testing === "draft" || !keyInput.trim()}
              onClick={() => void testDraft()}
            >
              {testing === "draft" ? "Testing…" : "Test key"}
            </Button>
          </div>
          {statusMessage && (
            <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{statusMessage}</p>
          )}
        </CardContent>
      </Card>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}
      >
        {providers.map((provider) => {
          // Remaining free-tier quota as a percent (gateway owns the ledger).
          const remainingPct =
            provider.quotaLimit != null && provider.quotaLimit > 0
              ? Math.max(
                  0,
                  Math.min(
                    100,
                    Math.round(
                      (1 - provider.quotaUsed / provider.quotaLimit) * 100,
                    ),
                  ),
                )
              : null;
          // Mirror web: only surface BYOK route options when a keyed provider is
          // in cooldown or down to its last ~20% of quota.
          const showRouteOptions =
            provider.hasKey &&
            (provider.inCooldown ||
              (remainingPct != null && remainingPct <= 20));
          return (
          <Card key={provider.id}>
            <CardHeader
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <CardTitle style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    backgroundColor: provider.color,
                  }}
                />
                {provider.name}
              </CardTitle>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-text-muted)" }}>
                P{provider.priority}
              </span>
            </CardHeader>
            <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <QuotaBar
                used={provider.quotaUsed}
                limit={provider.quotaLimit}
                label="Daily tokens"
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  color: "var(--color-text-sub)",
                }}
              >
                <span>{provider.hasKey ? "Key configured" : "No key"}</span>
                <span>{provider.enabled ? "Ready" : "Unavailable"}</span>
              </div>
              {provider.id !== "ollama" && provider.id !== "lmstudio" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {provider.hasKey && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={testing === provider.id}
                      onClick={() => void testStored(provider.id)}
                    >
                      {testing === provider.id ? "Testing…" : "Test key"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void revealMasked(provider.id)}
                  >
                    Masked preview
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeKey(provider.id)}
                  >
                    Remove
                  </Button>
                </div>
              )}
              {(provider.id === "ollama" || provider.id === "lmstudio") &&
                provider.enabled && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setSelectedProvider(provider.id);
                      router.push("/chat");
                    }}
                  >
                    Use in chat (on-device)
                  </Button>
                )}
              {showRouteOptions && (
                <RouteOptionsPanel
                  provider={provider.id}
                  quotaPct={remainingPct}
                />
              )}
            </CardContent>
          </Card>
          );
        })}
      </div>
    </div>
  );
}
