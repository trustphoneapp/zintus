"use client";

import { useCallback, useRef, useState } from "react";
import { Markdown } from "@/app/_components/Markdown";
import {
  streamResearch,
  type ResearchDepth,
  type ResearchSource,
} from "@/lib/research";
import {
  DATA_FLOW,
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import { Button } from "@/app/_components/ui/button";
import { Textarea } from "@/app/_components/ui/textarea";

type Stage =
  | "idle"
  | "planning"
  | "searching"
  | "reading"
  | "synthesizing"
  | "answering"
  | "done"
  | "error";

const FLOW: Stage[] = ["planning", "searching", "reading", "synthesizing", "answering", "done"];
const STAGE_LABEL: Record<Stage, string> = {
  idle: "Ready",
  planning: "Planning",
  searching: "Searching",
  reading: "Reading sources",
  synthesizing: "Synthesizing",
  answering: "Writing answer",
  done: "Done",
  error: "Error",
};
const DEPTHS: ResearchDepth[] = ["quick", "standard", "deep"];

function reportMarkdown(query: string, answer: string, sources: ResearchSource[]): string {
  const cites = sources.map((s, i) => `${i + 1}. [${s.title || s.url}](${s.url})`).join("\n");
  return `# ${query}\n\n${answer}\n\n## Sources\n${cites}\n`;
}

export default function ResearchPage() {
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState<ResearchDepth>("standard");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [queries, setQueries] = useState<string[]>([]);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q || running) return;
    // Consent before the first send to providers/search (parity w/ chat).
    if (!hasProviderSendConsent()) {
      setConsentOpen(true);
      return;
    }
    setRunning(true);
    setStage("planning");
    setQueries([]);
    setSources([]);
    setAnswer("");
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamResearch({
        query: q,
        depth,
        signal: controller.signal,
        events: {
          onQueries: (qs) => { setQueries(qs); setStage("searching"); },
          onSearchComplete: (_i, results) => { setSources((p) => [...p, ...results]); setStage("reading"); },
          onSynthesizing: () => setStage("synthesizing"),
          onAnswerChunk: (text) => { setAnswer(text); setStage("answering"); },
          onDone: (final) => { if (final.length) setSources(final); setStage("done"); },
          onError: (m) => { setError(m); setStage("error"); },
        },
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "Research failed");
        setStage("error");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [query, depth, running]);

  const stop = () => abortRef.current?.abort();

  const exportReport = () => {
    if (!answer) return;
    const blob = new Blob([reportMarkdown(query, answer, sources)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "zintus-research.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeIdx = FLOW.indexOf(stage);

  return (
    <div className="scroll" style={{ flex: 1, overflowY: "auto" }}>
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "22px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          width: "100%",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>Research</h1>
          {answer && !running ? (
            <Button type="button" variant="ghost" style={{ marginLeft: "auto" }} onClick={exportReport}>
              Export report
            </Button>
          ) : null}
        </div>
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 12,
            background: "var(--color-surface)",
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <p style={{ fontSize: 12.5, color: "var(--color-text-sub)", margin: 0 }}>
            Multi-step web research with cited sources, routed through your gateway.
            Requires a search key (Tavily/Serper) configured on the gateway.
          </p>
          <Textarea
            rows={2}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask a research question…"
          />
          <div className="flex items-center gap-2">
            <div className="seg">
              {DEPTHS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDepth(d)}
                  disabled={running}
                  className={depth === d ? "on" : undefined}
                  style={{ textTransform: "capitalize" }}
                >
                  {d}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {running ? (
              <Button type="button" variant="secondary" onClick={stop}>Stop</Button>
            ) : (
              <Button type="button" onClick={() => void run()} disabled={!query.trim()}>Research</Button>
            )}
          </div>

          {stage !== "idle" && (
            <div className="flex flex-wrap items-center gap-3" style={{ fontSize: 11 }}>
              {FLOW.map((s, i) => (
                <span key={s} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 8, height: 8, borderRadius: 4,
                      background:
                        stage === "error" && i === activeIdx ? "var(--color-error, #f87171)"
                        : i < activeIdx ? "var(--color-good, #34d399)"
                        : i === activeIdx ? "var(--color-purple-bright, #c4b5fd)"
                        : "var(--color-border)",
                    }}
                  />
                  <span style={{ color: i === activeIdx ? "var(--color-text)" : "var(--color-text-muted)", fontWeight: i === activeIdx ? 700 : 400 }}>
                    {STAGE_LABEL[s]}
                  </span>
                </span>
              ))}
            </div>
          )}

          {error && <p style={{ color: "var(--color-error, #f87171)", fontSize: 13 }}>{error}</p>}

          {queries.length > 0 && (
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 4px" }}>Search plan</h3>
              {queries.map((q, i) => (
                <p key={i} style={{ fontSize: 13, color: "var(--color-text-muted)", margin: "2px 0" }}>• {q}</p>
              ))}
            </div>
          )}

          {answer && (
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 4px" }}>Answer</h3>
              <Markdown content={answer} />
            </div>
          )}

          {sources.length > 0 && (
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 4px" }}>Sources ({sources.length})</h3>
              {sources.map((s, i) => (
                <a
                  key={`${s.url}-${i}`}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "block", textDecoration: "none",
                    border: "1px solid var(--color-border)", borderRadius: 8,
                    padding: 10, marginBottom: 8, background: "var(--color-elevated)",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text)" }}>{i + 1}. {s.title || s.url}</div>
                  <div style={{ fontSize: 11, color: "var(--color-purple-bright, #c4b5fd)" }}>{s.url}</div>
                  {s.content ? (
                    <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
                      {s.content.slice(0, 220)}
                    </div>
                  ) : null}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {consentOpen ? (
        <div className="consent-backdrop" role="dialog" aria-modal="true">
          <div className="consent-card">
            <h2 className="consent-title">Before your first send</h2>
            <p className="consent-body">
              Your research query and the pages it reads go to your gateway, a
              search provider, and the AI provider you chose. Here&apos;s where
              data travels:
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
                Got it — research
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
