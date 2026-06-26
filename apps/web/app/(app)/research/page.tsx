"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  streamResearch,
  type ResearchDepth,
  type ResearchSource,
} from "@/lib/gateway";
import { downloadFile } from "@/lib/download";
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

  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || running) {
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
          placeholder="What would you like to research?"
        />
        <div className="research-depths">
          {DEPTHS.map((option) => (
            <label key={option.value} className="research-depth">
              <input
                type="radio"
                name="depth"
                checked={depth === option.value}
                onChange={() => setDepth(option.value)}
                disabled={running}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint} · free</small>
              </span>
            </label>
          ))}
        </div>
        <button
          type="button"
          className="research-run"
          onClick={() => void run()}
          disabled={!query.trim() || running}
        >
          {running ? "Researching…" : "Start research →"}
        </button>
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
          {queries.length > 0 ? (
            <div className="research-step">
              <strong>Research angles</strong>
              <ul>
                {queries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {searches.length > 0 ? (
            <div className="research-step">
              <strong>Searching</strong>
              <ul>
                {searches.map((s) => (
                  <li key={s.index}>
                    {s.status === "done" ? "✓" : "⟳"} {s.query}
                    {s.count != null ? ` → ${s.count} results` : "…"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {synthSources != null ? (
            <div className="research-step">
              <strong>Synthesizing {synthSources} sources…</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      {answer ? (
        <div className="research-result">
          <div className="research-answer">{answer}</div>

          {sources.length > 0 ? (
            <details className="research-sources" open>
              <summary>{sources.length} sources</summary>
              <ol>
                {sources.map((s, i) => (
                  <li key={`${s.url}-${i}`}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.title || s.url}
                    </a>
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
    </div>
  );
}
