"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderId } from "@zintus/types";
import { streamChat } from "@/lib/chat-client";
import { fetchProviderInfos, type DesktopProviderInfo } from "@/lib/providers";
import { addSpendUsd } from "@/lib/spend";
import { useProviderStatusStore, useSettingsStore } from "@/lib/store";
import {
  DATA_FLOW,
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import { Markdown } from "@/app/_components/Markdown";
import { Button } from "@/app/_components/ui/button";

/**
 * Compare (Light.dc prototype): the same prompt sent to three providers at
 * once, each column streaming live with a real ms + $ footer. Columns run
 * against the gateway with a per-column provider override — no simulated
 * output, and a column reports its own error when its provider can't serve.
 */

interface Column {
  providerId: ProviderId;
  text: string;
  model: string | null;
  ms: number | null;
  costUsd: number | null;
  status: "idle" | "running" | "done" | "error";
  error: string | null;
}

const COLUMN_COUNT = 3;

function emptyColumn(providerId: ProviderId): Column {
  return { providerId, text: "", model: null, ms: null, costUsd: null, status: "idle", error: null };
}

export default function ComparePage() {
  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<DesktopProviderInfo[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [running, setRunning] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { settings, hydrate } = useSettingsStore();
  const setSelectedProvider = useProviderStatusStore((s) => s.setSelectedProvider);
  const selectedProvider = useProviderStatusStore((s) => s.selectedProvider);

  useEffect(() => {
    hydrate();
    let active = true;
    void fetchProviderInfos().then((infos) => {
      if (!active) return;
      setProviders(infos);
      // Default columns: the top available providers by router priority.
      const available = infos.filter((p) => p.enabled && !p.inCooldown);
      setColumns((current) =>
        current.length > 0
          ? current
          : available.slice(0, COLUMN_COUNT).map((p) => emptyColumn(p.id)),
      );
    });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [hydrate]);

  const available = providers.filter((p) => p.enabled && !p.inCooldown);

  const run = useCallback(async () => {
    const q = prompt.trim();
    if (!q || running || columns.length === 0) return;
    if (!hasProviderSendConsent()) {
      setConsentOpen(true);
      return;
    }
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setColumns((cols) => cols.map((c) => ({ ...emptyColumn(c.providerId), status: "running" as const })));

    await Promise.all(
      columns.map(async (column, index) => {
        const startedAt = performance.now();
        try {
          const result = await streamChat({
            messages: [{ role: "user", content: q }],
            providerId: column.providerId,
            settings,
            signal: controller.signal,
            onChunk: (text) => {
              setColumns((cols) =>
                cols.map((c, i) => (i === index ? { ...c, text: c.text + text } : c)),
              );
            },
          });
          const ms = Math.round(performance.now() - startedAt);
          if (result.meta?.costUsd) addSpendUsd(result.meta.costUsd);
          setColumns((cols) =>
            cols.map((c, i) =>
              i === index
                ? {
                    ...c,
                    status: "done",
                    model: result.model,
                    ms,
                    costUsd: result.meta?.costUsd ?? null,
                  }
                : c,
            ),
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          setColumns((cols) =>
            cols.map((c, i) =>
              i === index
                ? {
                    ...c,
                    status: "error",
                    error: error instanceof Error ? error.message : "Request failed",
                  }
                : c,
            ),
          );
        }
      }),
    );
    setRunning(false);
    abortRef.current = null;
  }, [prompt, running, columns, settings]);

  const stop = () => abortRef.current?.abort();

  function setColumnProvider(index: number, providerId: ProviderId) {
    setColumns((cols) => cols.map((c, i) => (i === index ? emptyColumn(providerId) : c)));
  }

  const providerInfo = (id: ProviderId) => providers.find((p) => p.id === id);

  return (
    <div className="scroll" style={{ flex: 1, overflowY: "auto" }}>
      <div
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          width: "100%",
        }}
      >
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>Compare</h1>
          <p style={{ fontSize: 12.5, color: "var(--color-text-sub)", margin: "2px 0 0" }}>
            Same prompt, {columns.length || COLUMN_COUNT} routes, live latency and cost per column.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !running) void run();
            }}
            placeholder="Prompt to send to all columns…"
            style={{
              flex: 1,
              height: 38,
              padding: "0 14px",
              border: "1px solid var(--color-border)",
              borderRadius: 10,
              background: "var(--color-surface)",
              color: "var(--color-text)",
              fontSize: 13.5,
              outline: "none",
            }}
          />
          {running ? (
            <Button type="button" variant="secondary" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void run()}
              disabled={!prompt.trim() || columns.length === 0}
            >
              Run · {columns.length || COLUMN_COUNT} models
            </Button>
          )}
        </div>

        {available.length < COLUMN_COUNT ? (
          <p style={{ fontSize: 12, color: "var(--color-text-muted)", margin: 0 }}>
            {available.length === 0
              ? "No providers available — connect keys on the Models page (or start Ollama) to run a comparison."
              : `Only ${available.length} provider${available.length === 1 ? "" : "s"} available — connect more on the Models page for a fuller comparison.`}
          </p>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, 1fr)`,
            gap: 12,
            alignItems: "start",
          }}
        >
          {columns.map((column, index) => {
            const info = providerInfo(column.providerId);
            return (
              <div
                key={`${column.providerId}-${index}`}
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: 12,
                  background: "var(--color-surface)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--color-border)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 10,
                      fontWeight: 700,
                      background: "var(--color-elevated)",
                      color: info?.color ?? "var(--color-text-sub)",
                      flexShrink: 0,
                    }}
                  >
                    {(info?.name ?? column.providerId)[0]?.toUpperCase()}
                  </span>
                  <select
                    aria-label={`Provider for column ${index + 1}`}
                    value={column.providerId}
                    disabled={running}
                    onChange={(e) => setColumnProvider(index, e.target.value as ProviderId)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "var(--color-text)",
                      fontSize: 12.5,
                      fontWeight: 600,
                      outline: "none",
                      cursor: "pointer",
                      maxWidth: 130,
                    }}
                  >
                    {(available.some((p) => p.id === column.providerId)
                      ? available
                      : [...available, ...(info ? [info] : [])]
                    ).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {column.model ? (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: "var(--color-text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {column.model}
                    </span>
                  ) : null}
                </div>

                <div style={{ padding: 12, fontSize: 13, lineHeight: 1.6, minHeight: 120, color: "var(--color-text)" }}>
                  {column.status === "idle" && !column.text ? (
                    <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                      Waiting for a run.
                    </span>
                  ) : null}
                  {column.status === "error" ? (
                    <span style={{ color: "var(--color-red)", fontSize: 12 }}>{column.error}</span>
                  ) : (
                    <Markdown content={column.text} />
                  )}
                  {column.status === "running" && !column.text ? (
                    <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>Streaming…</span>
                  ) : null}
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    borderTop: "1px solid var(--color-border)",
                    fontSize: 10.5,
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-muted)",
                  }}
                >
                  <span>{column.ms != null ? `${column.ms} ms` : "— ms"}</span>
                  <span>·</span>
                  <span>
                    {column.costUsd != null
                      ? `$${column.costUsd.toFixed(4)}`
                      : column.status === "done"
                        ? "$ n/a"
                        : "$ —"}
                  </span>
                  <span style={{ marginLeft: "auto" }}>
                    <button
                      type="button"
                      className="app-icon-btn"
                      disabled={column.status !== "done"}
                      onClick={() => setSelectedProvider(column.providerId)}
                      style={{
                        border: "none",
                        background: "transparent",
                        fontSize: 10.5,
                        fontWeight: 600,
                        color:
                          selectedProvider === column.providerId
                            ? "var(--color-green)"
                            : "var(--color-purple-bright)",
                        cursor: column.status === "done" ? "pointer" : "default",
                        opacity: column.status === "done" || selectedProvider === column.providerId ? 1 : 0.5,
                      }}
                    >
                      {selectedProvider === column.providerId ? "✓ chat default" : "use for chat"}
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {consentOpen ? (
        <div className="consent-backdrop" role="dialog" aria-modal="true">
          <div className="consent-card">
            <h2 className="consent-title">Before your first send</h2>
            <p className="consent-body">
              Your prompt goes to your gateway and then to each provider column
              you selected. Here&apos;s where data travels:
            </p>
            <div className="consent-flow">
              {DATA_FLOW.map((item) => (
                <div key={item.data} className="consent-flow-item">
                  <span className="consent-flow-dest">{item.dest}</span>
                  <span className="consent-flow-data">{item.data}</span>
                  <span className="consent-flow-detail">{item.detail}</span>
                </div>
              ))}
            </div>
            <div className="consent-actions">
              <Button type="button" variant="secondary" onClick={() => setConsentOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  grantProviderSendConsent();
                  setConsentOpen(false);
                  void run();
                }}
              >
                Got it — run
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
