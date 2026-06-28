"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID, PROVIDERS } from "@/lib/providers";
import { streamChat } from "@/lib/chat-client";
import {
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import { ConsentDialog } from "@/app/_components/ConsentDialog";
import type { ChatMeta } from "@/lib/gateway";
import {
  createAssistantPlaceholder,
  createUserMessage,
  useAppStore,
} from "@/lib/app-store";
import { useSettingsStore } from "@/lib/store";
import { Icon } from "@/app/_components/Icons";
import { TransparencyStrip } from "@/app/_components/TransparencyStrip";

interface CompareColumn {
  id: string;
  provider: ProviderId;
}

interface ColumnResult {
  text: string;
  status: "idle" | "streaming" | "done" | "error";
  meta?: ChatMeta;
  error?: string;
}

const MAX_COLUMNS = 4;
const MIN_COLUMNS = 2;

const DEFAULT_COLUMNS: CompareColumn[] = [
  { id: "col-1", provider: "groq" },
  { id: "col-2", provider: "gemini" },
];

const EMPTY_RESULT: ColumnResult = { text: "", status: "idle" };

export default function ComparePage() {
  const router = useRouter();
  const { settings, hydrate } = useSettingsStore();
  const { gatewayConnected, newChat, appendMessage, updateMessage, patchMessage } =
    useAppStore();

  const [columns, setColumns] = useState<CompareColumn[]>(DEFAULT_COLUMNS);
  const [results, setResults] = useState<Record<string, ColumnResult>>({});
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [lastPrompt, setLastPrompt] = useState("");

  const controllers = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Abort every in-flight stream when leaving the page.
  useEffect(() => {
    return () => {
      for (const controller of controllers.current.values()) {
        controller.abort();
      }
    };
  }, []);

  const setResult = useCallback(
    (id: string, patch: Partial<ColumnResult>) => {
      setResults((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? EMPTY_RESULT), ...patch },
      }));
    },
    [],
  );

  const streamColumn = useCallback(
    async (column: CompareColumn, userContent: string) => {
      const controller = new AbortController();
      controllers.current.set(column.id, controller);
      setResult(column.id, { text: "", status: "streaming", error: undefined, meta: undefined });
      try {
        const result = await streamChat({
          messages: [{ role: "user", content: userContent }],
          providerId: column.provider,
          settings,
          webSearch,
          signal: controller.signal,
          onChunk: (text) => setResult(column.id, { text }),
        });
        setResult(column.id, { status: "done", meta: result.meta });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          // Stopped — keep whatever streamed so far; mark done so the column
          // doesn't sit stuck in "streaming".
          setResult(column.id, { status: "done" });
          return;
        }
        setResult(column.id, {
          status: "error",
          error: error instanceof Error ? error.message : "Request failed",
        });
      } finally {
        controllers.current.delete(column.id);
      }
    },
    [setResult, settings, webSearch],
  );

  const runCompare = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || running) {
      return;
    }
    if (!hasProviderSendConsent()) {
      setConsentOpen(true);
      return;
    }
    setRunning(true);
    setLastPrompt(trimmed);
    // Fan out to every column simultaneously; each streams independently.
    await Promise.allSettled(
      columns.map((column) => streamColumn(column, trimmed)),
    );
    setRunning(false);
  }, [columns, prompt, running, streamColumn]);

  const stopAll = useCallback(() => {
    for (const controller of controllers.current.values()) {
      controller.abort();
    }
    controllers.current.clear();
    setRunning(false);
  }, []);

  // Stop a single column without touching the others; the AbortError handler in
  // streamColumn keeps whatever streamed so far and marks the column done.
  const stopColumn = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
  }, []);

  const regenerateColumn = useCallback(
    async (column: CompareColumn) => {
      if (!lastPrompt || running) {
        return;
      }
      await streamColumn(column, lastPrompt);
    },
    [lastPrompt, running, streamColumn],
  );

  const addColumn = useCallback(() => {
    setColumns((prev) => {
      if (prev.length >= MAX_COLUMNS) {
        return prev;
      }
      const used = new Set(prev.map((c) => c.provider));
      const next =
        PROVIDERS.find((p) => !used.has(p.id))?.id ?? PROVIDERS[0]?.id ?? "groq";
      return [...prev, { id: `col-${Date.now()}`, provider: next }];
    });
  }, []);

  const removeColumn = useCallback((id: string) => {
    setColumns((prev) =>
      prev.length <= MIN_COLUMNS ? prev : prev.filter((c) => c.id !== id),
    );
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
  }, []);

  const setColumnProvider = useCallback((id: string, provider: ProviderId) => {
    setColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, provider } : c)),
    );
    // Drop the previous provider's result so its metadata doesn't show under the
    // new provider until re-run.
    setResults((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const useAnswer = useCallback(
    (column: CompareColumn, result: ColumnResult) => {
      newChat();
      appendMessage(createUserMessage(lastPrompt));
      const assistant = createAssistantPlaceholder();
      appendMessage(assistant);
      updateMessage(assistant.id, result.text);
      patchMessage(assistant.id, {
        providerId: column.provider,
        model: result.meta?.model,
        meta: result.meta,
      });
      router.push("/chat");
    },
    [appendMessage, lastPrompt, newChat, patchMessage, router, updateMessage],
  );

  // Winner badges, computed once every column finished.
  const done = columns
    .map((c) => ({ column: c, result: results[c.id] }))
    .filter(
      (entry): entry is { column: CompareColumn; result: ColumnResult } =>
        entry.result?.status === "done" && Boolean(entry.result.meta),
    );
  const allDone = done.length === columns.length && columns.length > 0;
  const fastest = allDone
    ? done.reduce((a, b) =>
        (a.result.meta!.latencyMs ?? Infinity) <
        (b.result.meta!.latencyMs ?? Infinity)
          ? a
          : b,
      )
    : null;
  const longest = allDone
    ? done.reduce((a, b) =>
        (a.result.meta!.outputTokens ?? 0) > (b.result.meta!.outputTokens ?? 0)
          ? a
          : b,
      )
    : null;

  return (
    <div className="screen compare-screen">
      <div className="compare-composer" style={{ position: "sticky", top: 0, zIndex: 2 }}>
        <textarea
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void runCompare();
            }
          }}
          placeholder="Ask the same question across providers — ⌘⏎ to compare"
        />
        <div className="compare-composer-actions">
          <button
            type="button"
            className={`chat-tool-toggle${webSearch ? " active" : ""}`}
            onClick={() => setWebSearch((v) => !v)}
            title="Apply web search to every column"
          >
            <Icon name="globe" size={13} />
            Search
          </button>
          <button
            type="button"
            className="compare-add"
            onClick={addColumn}
            disabled={columns.length >= MAX_COLUMNS}
            title={`Up to ${MAX_COLUMNS} providers side-by-side`}
          >
            <Icon name="plus" size={13} />
            Add column
          </button>
          <span
            style={{
              fontSize: 12,
              color: "var(--color-text-muted)",
              marginRight: "auto",
            }}
          >
            {columns.length} providers
          </span>
          {running ? (
            <button type="button" className="compare-add" onClick={stopAll}>
              <Icon name="x" size={13} />
              Stop all
            </button>
          ) : null}
          <button
            type="button"
            className="compare-run"
            onClick={() => void runCompare()}
            disabled={!prompt.trim() || running}
            style={{ marginLeft: 0 }}
          >
            {running ? "Comparing…" : "Compare"}
          </button>
        </div>
      </div>

      {!gatewayConnected ? (
        <p className="chat-empty-offline">
          No gateway connected — Zintus is local-first, so start your gateway
          with <code>zintus serve</code>, then reload.{" "}
          <a href="/docs#self-host">Self-host guide →</a>
        </p>
      ) : null}

      {allDone ? (
        <div className="compare-summary">
          {fastest ? (
            <span>
              ⚡ Fastest:{" "}
              <strong>{PROVIDER_BY_ID[fastest.column.provider].name}</strong> (
              {fastest.result.meta!.latencyMs}ms)
            </span>
          ) : null}
          {longest ? (
            <span>
              📝 Longest:{" "}
              <strong>{PROVIDER_BY_ID[longest.column.provider].name}</strong> (
              {longest.result.meta!.outputTokens.toLocaleString()} tokens)
            </span>
          ) : null}
          <span>💰 All free — 0 markup on any</span>
        </div>
      ) : null}

      <div
        className="compare-columns"
        style={{
          gridTemplateColumns: `repeat(${columns.length}, minmax(260px, 1fr))`,
          overflowX: "auto",
        }}
      >
        {columns.map((column) => {
          const result = results[column.id] ?? EMPTY_RESULT;
          const provider = PROVIDER_BY_ID[column.provider];
          const isWinner = allDone && fastest?.column.id === column.id;
          return (
            <div
              key={column.id}
              className={`compare-column${isWinner ? " winner" : ""}`}
            >
              <div className="compare-column-head">
                <span
                  className="message-provider-dot"
                  style={{ background: provider.color }}
                />
                <select
                  value={column.provider}
                  onChange={(event) =>
                    setColumnProvider(column.id, event.target.value as ProviderId)
                  }
                  disabled={running}
                  className="compare-provider-select"
                  style={{ flex: "0 1 auto" }}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {result.meta?.model ? (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--color-text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                    title={result.meta.model}
                  >
                    {result.meta.model}
                  </span>
                ) : null}
                <span style={{ flex: 1 }} />
                {result.status === "streaming" ? (
                  <button
                    type="button"
                    className="compare-column-remove"
                    onClick={() => stopColumn(column.id)}
                    aria-label="Stop this column"
                    title="Stop streaming"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 11,
                      color: "var(--color-text-sub)",
                    }}
                  >
                    <Icon name="x" size={12} />
                    Stop
                  </button>
                ) : columns.length > MIN_COLUMNS ? (
                  <button
                    type="button"
                    className="compare-column-remove"
                    onClick={() => removeColumn(column.id)}
                    aria-label="Remove column"
                  >
                    <Icon name="x" size={12} />
                  </button>
                ) : null}
              </div>

              <div className="compare-column-body">
                {result.status === "idle" ? (
                  <span className="compare-placeholder">
                    Answer appears here.
                  </span>
                ) : result.status === "error" ? (
                  <span className="compare-error">Error: {result.error}</span>
                ) : result.text ? (
                  result.text
                ) : (
                  <span className="message-thinking">Thinking…</span>
                )}
              </div>

              {result.meta ? <TransparencyStrip meta={result.meta} /> : null}

              {result.status === "done" && result.text ? (
                <div className="compare-column-actions">
                  <button
                    type="button"
                    className="message-action"
                    onClick={() => useAnswer(column, result)}
                  >
                    Use this answer →
                  </button>
                  <button
                    type="button"
                    className="message-action"
                    onClick={() => void navigator.clipboard.writeText(result.text)}
                  >
                    <Icon name="copy" size={13} />
                    Copy
                  </button>
                  <button
                    type="button"
                    className="message-action"
                    onClick={() => void regenerateColumn(column)}
                    disabled={running}
                  >
                    <Icon name="refresh" size={13} />
                    Regenerate
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <ConsentDialog
        open={consentOpen}
        onCancel={() => setConsentOpen(false)}
        onGrant={() => {
          grantProviderSendConsent();
          setConsentOpen(false);
          void runCompare();
        }}
      />
    </div>
  );
}
