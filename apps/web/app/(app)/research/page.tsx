"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  streamResearch,
  type ResearchDepth,
  type ResearchSource,
} from "@/lib/gateway";
import { downloadFile } from "@/lib/download";
import {
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import { ConsentDialog } from "@/app/_components/ConsentDialog";
import { useAppStore } from "@/lib/app-store";
import {
  createAssistantPlaceholder,
  createUserMessage,
} from "@/lib/app-store";

interface SearchProgress {
  index: number;
  query: string;
  status: "running" | "done";
  count?: number;
}

const DEPTHS: Array<{ value: ResearchDepth; label: string; hint: string }> = [
  { value: "quick", label: "Quick", hint: "1 search · ~10s" },
  { value: "standard", label: "Standard", hint: "3 searches · ~30s" },
  { value: "deep", label: "Deep", hint: "5 searches · ~60s" },
];

/** Bare domain for a source URL, used as a trust signal in citations. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function ResearchPage() {
  const router = useRouter();
  const { gatewayConnected, newChat, appendMessage, updateMessage } =
    useAppStore();

  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState<ResearchDepth>("standard");
  const [running, setRunning] = useState(false);
  const [queries, setQueries] = useState<string[]>([]);
  const [searches, setSearches] = useState<SearchProgress[]>([]);
  const [synthSources, setSynthSources] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [consentOpen, setConsentOpen] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || running) {
      return;
    }
    // Consent before the first send to providers/search (parity w/ chat).
    if (!hasProviderSendConsent()) {
      setConsentOpen(true);
      return;
    }
    setRunning(true);
    setError(null);
    setQueries([]);
    setSearches([]);
    setSynthSources(null);
    setAnswer("");
    setSources([]);
    setLastQuery(trimmed);

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      await streamResearch({
        query: trimmed,
        depth,
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case "queries":
              setQueries(event.queries);
              break;
            case "search_start":
              setSearches((prev) => [
                ...prev,
                { index: event.index, query: event.query, status: "running" },
              ]);
              break;
            case "search_complete":
              setSearches((prev) =>
                prev.map((s) =>
                  s.index === event.index
                    ? { ...s, status: "done", count: event.results.length }
                    : s,
                ),
              );
              break;
            case "synthesizing":
              setSynthSources(event.sourceCount);
              break;
            case "answer_chunk":
              setAnswer((prev) => prev + event.text);
              break;
            case "done":
              setSources(event.sources);
              break;
            case "error":
              setError(event.message);
              break;
          }
        },
      });
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Research failed");
      }
    } finally {
      setRunning(false);
    }
  }, [depth, query, running]);

  const stop = useCallback(() => {
    // AbortError is swallowed by run()'s catch, so this ends the stream cleanly.
    controllerRef.current?.abort();
  }, []);

  const continueInChat = useCallback(() => {
    newChat();
    appendMessage(createUserMessage(lastQuery));
    const assistant = createAssistantPlaceholder();
    appendMessage(assistant);
    updateMessage(assistant.id, answer);
    router.push("/chat");
  }, [answer, appendMessage, lastQuery, newChat, router, updateMessage]);

  function download() {
    const md = `# ${lastQuery}\n\n${answer}\n\n## Sources\n${sources
      .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
      .join("\n")}`;
    downloadFile("research.md", md, "text/markdown");
  }

  const started = queries.length > 0 || running || Boolean(answer) || Boolean(error);
  const searchesDone = searches.filter((s) => s.status === "done").length;
  // Stage flags drive the live stepper's "active vs. done" markers.
  const planDone = searches.length > 0 || synthSources != null || Boolean(answer);
  const searchDone = synthSources != null || Boolean(answer);
  const synthDone = Boolean(answer);

  return (
    <div className="screen research-screen">
      <div className="research-header">
        <h2>Deep Research</h2>
        <p>Searches multiple sources, synthesizes findings, cites every claim.</p>
      </div>

      <div className="research-input">
        <textarea
          rows={3}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void run();
            }
          }}
          placeholder="Ask a research question — e.g. “Compare the leading open-source vector databases.”"
        />

        <div className="research-depths" role="radiogroup" aria-label="Research depth">
          {DEPTHS.map((option) => {
            const active = depth === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={running}
                onClick={() => setDepth(option.value)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  minWidth: 124,
                  padding: "8px 12px",
                  textAlign: "left",
                  cursor: running ? "not-allowed" : "pointer",
                  border: "0.5px solid",
                  borderColor: active ? "var(--c-accent)" : "var(--c-border)",
                  borderRadius: "var(--radius-md)",
                  background: active ? "var(--c-accent-light)" : "transparent",
                  color: "var(--color-text)",
                  opacity: running && !active ? 0.5 : 1,
                  transition: "border-color var(--t-fast), background var(--t-fast)",
                }}
              >
                <strong style={{ fontSize: 13 }}>{option.label}</strong>
                <small style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                  {option.hint} · free
                </small>
              </button>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <small style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            Press ⌘↵ to run · every claim is linked to a source
          </small>
          <div style={{ display: "flex", gap: 8 }}>
            {running ? (
              <button
                type="button"
                className="research-run"
                onClick={stop}
                style={{
                  background: "transparent",
                  color: "var(--color-text)",
                  borderColor: "var(--c-border-strong)",
                  boxShadow: "none",
                }}
              >
                ■ Stop
              </button>
            ) : null}
            <button
              type="button"
              className="research-run"
              onClick={() => void run()}
              disabled={!query.trim() || running}
            >
              {running ? (
                <>
                  <span className="btn-spinner" />
                  Researching…
                </>
              ) : (
                "Start research →"
              )}
            </button>
          </div>
        </div>
      </div>

      {!gatewayConnected ? (
        <p className="chat-empty-offline">
          No gateway connected — Zintus is local-first, so start your gateway
          with <code>zintus serve</code>, then reload.{" "}
          <a href="/docs#self-host">Self-host guide →</a>. Deep research also
          needs a Tavily or Serper key on the gateway.
        </p>
      ) : null}

      {error ? <p className="research-error">Error: {error}</p> : null}

      {started ? (
        <div className="research-progress">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingBottom: 10,
              borderBottom:
                "1px solid color-mix(in oklch, var(--color-text-muted) 14%, transparent)",
            }}
          >
            {running ? (
              <span className="thinking-dot" />
            ) : (
              <span style={{ color: "var(--color-green)" }}>✓</span>
            )}
            <strong style={{ fontSize: 13 }}>
              {running ? "Researching…" : "Research complete"}
            </strong>
            <small
              style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-muted)" }}
            >
              {DEPTHS.find((d) => d.value === depth)?.label} mode
            </small>
          </div>

          <div className="research-step">
            <strong>
              {planDone ? "✓ " : "● "}Planned {queries.length || ""} research{" "}
              {queries.length === 1 ? "angle" : "angles"}
            </strong>
            {queries.length > 0 ? (
              <ul>
                {queries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {searches.length > 0 ? (
            <div className="research-step">
              <strong>
                {searchDone ? "✓ " : "● "}Searched {searchesDone}/{searches.length} sources
              </strong>
              <ul style={{ listStyle: "none", paddingLeft: 2 }}>
                {searches.map((s) => (
                  <li key={s.index} style={{ display: "flex", gap: 6 }}>
                    <span
                      style={{
                        color:
                          s.status === "done"
                            ? "var(--color-green)"
                            : "var(--color-text-muted)",
                      }}
                    >
                      {s.status === "done" ? "✓" : "⟳"}
                    </span>
                    <span style={{ flex: 1 }}>{s.query}</span>
                    {s.count != null ? (
                      <span style={{ color: "var(--color-text-muted)" }}>
                        {s.count} results
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {synthSources != null ? (
            <div className="research-step">
              <strong>
                {synthDone ? "✓ " : "● "}Synthesizing {synthSources} sources
                {synthDone ? "" : "…"}
              </strong>
            </div>
          ) : null}
        </div>
      ) : null}

      {answer ? (
        <div className="research-result">
          {sources.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {sources.map((s, i) => (
                <a
                  key={`chip-${s.url}-${i}`}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={s.title || s.url}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px 4px 4px",
                    borderRadius: "var(--radius-sm)",
                    border: "0.5px solid var(--c-border)",
                    background: "var(--c-inset)",
                    fontSize: 11,
                    color: "var(--color-text-sub)",
                    textDecoration: "none",
                    maxWidth: 220,
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      background: "var(--c-accent-light)",
                      color: "var(--c-accent)",
                      fontWeight: 600,
                      fontSize: 10,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {hostOf(s.url)}
                  </span>
                </a>
              ))}
            </div>
          ) : null}

          <div className="research-answer">
            {answer}
            {running ? <span className="stream-caret" /> : null}
          </div>

          {sources.length > 0 ? (
            <details className="research-sources" open>
              <summary>
                {sources.length} {sources.length === 1 ? "source" : "sources"} cited
              </summary>
              <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
                {sources.map((s, i) => (
                  <li
                    key={`${s.url}-${i}`}
                    style={{ display: "flex", gap: 10, alignItems: "baseline" }}
                  >
                    <span
                      style={{
                        flex: "0 0 auto",
                        minWidth: 18,
                        textAlign: "right",
                        color: "var(--c-accent)",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {i + 1}.
                    </span>
                    <span
                      style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}
                    >
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--color-text)", fontWeight: 500 }}
                      >
                        {s.title || s.url}
                      </a>
                      <small style={{ color: "var(--color-text-muted)", fontSize: 11 }}>
                        {hostOf(s.url)}
                      </small>
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}

          {!running ? (
            <div className="research-actions">
              <button
                type="button"
                className="message-action"
                onClick={() => void navigator.clipboard.writeText(answer)}
              >
                Copy
              </button>
              <button type="button" className="message-action" onClick={download}>
                Download .md
              </button>
              <button
                type="button"
                className="message-action"
                onClick={continueInChat}
              >
                Continue in chat →
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ConsentDialog
        open={consentOpen}
        onCancel={() => setConsentOpen(false)}
        onGrant={() => {
          grantProviderSendConsent();
          setConsentOpen(false);
          void run();
        }}
      />
    </div>
  );
}
