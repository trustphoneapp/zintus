"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_METADATA, supportsTools } from "@zintus/providers";
import { useProviderStatusStore } from "@/lib/store";
import {
  createAgentTask,
  followUpAgent,
  listAgents,
  resolveApproval,
  resumeAgent,
  stopAgent,
  streamAgentEvents,
  type AgentEvent,
  type AgentSummary,
} from "@/lib/agents";

/**
 * Agent — the desktop operator console for the gateway-hosted coding agent
 * (`/v1/agents`). Same "mission console" language as web: arm a task, watch the
 * live instrument readout, and every write HALTS at an approval gate. This is
 * the desktop's "My Computer" surface — the agent runs on THIS machine.
 */

type RunState = "idle" | "running" | "awaiting" | "done" | "stopped" | "error";

const STATE_LABEL: Record<RunState, string> = {
  idle: "Ready",
  running: "Running",
  awaiting: "Awaiting approval",
  done: "Done",
  stopped: "Stopped",
  error: "Error",
};

export default function AgentPage() {
  const [task, setTask] = useState("");
  const [root, setRoot] = useState("");
  const [allowRun, setAllowRun] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  // Model picker: "" = Auto (router picks among TOOL-CAPABLE providers only).
  // Non-tool providers are listed but disabled — agent turns are tool loops,
  // and a model that can't call tools just narrates pseudocode.
  const [agentProvider, setAgentProvider] = useState<ProviderId | "">("");
  const { providers, refresh: refreshProviders } = useProviderStatusStore();
  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);
  const connectedProviders = providers.filter((entry) =>
    entry.id === "ollama" || entry.id === "lmstudio" ? entry.enabled : entry.hasKey,
  );
  const providerToolBlocked =
    agentProvider !== "" && !supportsTools(agentProvider);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  const resolved = useMemo(
    () =>
      new Set(
        events
          .filter((e) => e.type === "approval_resolved")
          .map((e) => String(e.approval_id)),
      ),
    [events],
  );
  const pending = events.filter(
    (e) => e.type === "approval_required" && !resolved.has(String(e.approval_id)),
  );

  const runState: RunState = useMemo(() => {
    if (error) return "error";
    const last = [...events].reverse().find((e) =>
      ["done", "stopped", "error"].includes(e.type),
    );
    if (last?.type === "done") return "done";
    if (last?.type === "stopped") return "stopped";
    if (last?.type === "error") return "error";
    if (pending.length > 0) return "awaiting";
    if (running) return "running";
    return "idle";
  }, [events, running, error, pending.length]);

  const rounds = useMemo(() => {
    const r = [...events].reverse().find((e) => typeof e.round === "number");
    return typeof r?.round === "number" ? r.round + 1 : 0;
  }, [events]);

  // One-line live activity while running (P3): the most recent tool_call that
  // has no matching tool_result yet, phrased as a present-tense action;
  // otherwise the model is generating. Disappears when the run ends.
  const activity = useMemo(() => {
    if (runState !== "running") return null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.type === "tool_result") break; // last call resolved → model's turn
      if (e.type === "tool_call") {
        const args = (e.arguments ?? {}) as Record<string, unknown>;
        const p = typeof args.path === "string" ? args.path : "";
        switch (e.tool) {
          case "read_file":
            return `Reading ${p || "a file"}…`;
          case "write_file":
          case "edit_file":
            return `Writing ${p || "a file"}…`;
          case "list_directory":
            return `Listing ${p || "the workspace"}…`;
          case "search_code":
            return `Searching for ${typeof args.query === "string" ? `"${args.query}"` : "code"}…`;
          case "run_command":
            return `Running: ${typeof args.command === "string" ? args.command : "a command"}…`;
          case "browse":
            return `Browsing ${typeof args.url === "string" ? args.url : "the web"}…`;
          default:
            return `Waiting for ${String(e.tool)} result…`;
        }
      }
    }
    return "Thinking…";
  }, [events, runState]);

  const start = useCallback(async () => {
    if (!task.trim() || running) return;
    // Tool-capability gate: block the launch outright on a non-tool model —
    // the run would produce narration, not work (live-tested failure mode).
    if (agentProvider !== "" && !supportsTools(agentProvider)) {
      setError(
        "This model can't use tools. Agent tasks need a tool-capable model. Switch to Gemini, Claude, or a cloud model.",
      );
      return;
    }
    setEvents([]);
    setError(null);
    setRunning(true);
    try {
      const id = await createAgentTask({
        task,
        root: root.trim() || undefined,
        allowRun,
        autoApprove,
        sandbox: allowRun ? sandbox : false,
        browse,
        provider: agentProvider || undefined,
      });
      setAgentId(id);
      const controller = new AbortController();
      abortRef.current = controller;
      await streamAgentEvents(
        id,
        (e) => setEvents((prev) => [...prev, e]),
        controller.signal,
      );
    } catch (err) {
      if (!abortRef.current?.signal.aborted) {
        setError(err instanceof Error ? err.message : "Agent request failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [task, root, allowRun, sandbox, browse, autoApprove, running, agentProvider]);

  const stop = useCallback(() => {
    if (agentId) void stopAgent(agentId);
  }, [agentId]);

  // P6 — session resume: the gateway recovers non-terminal runs from
  // ~/.zintus/agents on startup as "interrupted". Offer the newest one from
  // the last 24h; Resume re-enters the loop from its checkpoint and the full
  // backlog replay reconstructs the panel.
  const [resumable, setResumable] = useState<AgentSummary | null>(null);
  useEffect(() => {
    void listAgents().then((all) => {
      const candidate = all
        .filter(
          (a) =>
            a.status === "interrupted" &&
            Date.now() - a.created_at < 24 * 60 * 60 * 1000,
        )
        .sort((a, b) => b.created_at - a.created_at)[0];
      setResumable(candidate ?? null);
    });
  }, []);
  const resume = useCallback(async () => {
    if (!resumable || running) return;
    setResumable(null);
    setError(null);
    setEvents([]);
    setTask(resumable.task);
    setAgentId(resumable.id);
    setRunning(true);
    try {
      await resumeAgent(resumable.id);
      const controller = new AbortController();
      abortRef.current = controller;
      await streamAgentEvents(
        resumable.id,
        (e) => setEvents((prev) => [...prev, e]),
        controller.signal,
      );
    } catch (err) {
      if (!abortRef.current?.signal.aborted) {
        setError(err instanceof Error ? err.message : "Resume failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [resumable, running]);

  // P2 — follow-up in the SAME session (default after done/stopped). The panel
  // never clears: we re-subscribe and the gateway replays the FULL multi-
  // exchange backlog (exchange-stamped), which reconstructs history + streams
  // the new exchange live.
  const [followUpText, setFollowUpText] = useState("");
  const sendFollowUp = useCallback(async () => {
    const message = followUpText.trim();
    if (!message || !agentId || running) return;
    setError(null);
    setRunning(true);
    setFollowUpText("");
    try {
      await followUpAgent(agentId, message);
      setEvents([]); // repopulated by the full backlog replay below
      const controller = new AbortController();
      abortRef.current = controller;
      await streamAgentEvents(
        agentId,
        (e) => setEvents((prev) => [...prev, e]),
        controller.signal,
      );
    } catch (err) {
      if (!abortRef.current?.signal.aborted) {
        setError(err instanceof Error ? err.message : "Follow-up failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [agentId, followUpText, running]);

  const approve = useCallback(
    (approvalId: string, approved: boolean) => {
      if (agentId) void resolveApproval(agentId, approvalId, approved);
    },
    [agentId],
  );

  const armed = task.trim().length > 0;
  const launchOpen = runState === "idle" || runState === "error";

  return (
    <div className="agent-screen">
      <div className={`agent-strip agent-strip--${runState}`}>
        <span className="agent-strip-dot" aria-hidden />
        <span className="agent-strip-state">{STATE_LABEL[runState]}</span>
        {rounds > 0 ? <span className="agent-strip-meta">round {rounds}</span> : null}
        <span className="agent-strip-spacer" />
        {running ? (
          <button type="button" className="agent-stop" onClick={stop}>
            Stop run
          </button>
        ) : null}
      </div>
      {activity ? (
        <p className="agent-activity" aria-live="polite">
          {activity}
        </p>
      ) : null}

      <div className="agent-body">
        {resumable && runState === "idle" ? (
          <div className="agent-resume">
            <span className="agent-resume-text">
              Resume last session? <code>{resumable.task}</code>
            </span>
            <button type="button" className="agent-launch-btn" onClick={() => void resume()}>
              Resume
            </button>
            <button
              type="button"
              className="agent-relaunch"
              onClick={() => setResumable(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {launchOpen ? (
          <section className="agent-launch">
            <label className="agent-field">
              <span className="agent-field-label">Task</span>
              <textarea
                className="agent-task-input"
                placeholder="Describe what the agent should do — e.g. add a --json flag to the export script and update its test"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={3}
              />
            </label>
            <label className="agent-field">
              <span className="agent-field-label">Sandbox root</span>
              <input
                className="agent-root-input"
                placeholder="Path on this machine — defaults to the gateway workspace"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
              />
            </label>

            <label className="agent-field">
              <span className="agent-field-label">Model</span>
              <select
                className="agent-root-input"
                value={agentProvider}
                onChange={(e) => setAgentProvider(e.target.value as ProviderId | "")}
              >
                <option value="">Auto — router picks a tool-capable model</option>
                {connectedProviders.map((p) => {
                  const toolCapable = supportsTools(p.id);
                  return (
                    <option key={p.id} value={p.id} disabled={!toolCapable}>
                      {PROVIDER_METADATA[p.id]?.name ?? p.id}
                      {toolCapable ? "" : " — not compatible with agent mode (no tool use)"}
                    </option>
                  );
                })}
              </select>
            </label>
            {providerToolBlocked ? (
              <p className="agent-error">
                This model can&apos;t use tools. Agent tasks need a tool-capable
                model. Switch to Gemini, Claude, or a cloud model.
              </p>
            ) : null}

            <div className="agent-switches">
              <Switch checked={allowRun} onChange={setAllowRun} label="Run verify commands" hint="bun test / typecheck" />
              <Switch checked={sandbox} onChange={setSandbox} disabled={!allowRun} label="Docker sandbox" hint="isolate commands" />
              <Switch checked={browse} onChange={setBrowse} label="Browser tool" hint="read web pages" />
              <Switch checked={autoApprove} onChange={setAutoApprove} label="Auto-approve" hint="skip the gate — careful" tone="warn" />
            </div>

            <div className="agent-launch-actions">
              <button
                type="button"
                className="agent-launch-btn"
                onClick={() => void start()}
                disabled={!armed || providerToolBlocked}
              >
                {providerToolBlocked
                  ? "Switch to a tool-capable model"
                  : armed
                    ? "Launch agent"
                    : "Enter a task to launch"}
              </button>
              <p className="agent-launch-note">
                Runs on this machine, sandboxed to the root above. Docker and the
                browser tool need those installed. Browsing blocks internal hosts
                by default.
              </p>
            </div>

            {error ? <p className="agent-error">{error}</p> : null}
          </section>
        ) : (
          <div className="agent-run-summary">
            <span className="agent-run-task" title={task}>
              {task}
            </span>
            <button
              type="button"
              className="agent-relaunch"
              onClick={() => {
                // Explicit fresh start — continuing below is the default.
                setEvents([]);
                setError(null);
                setAgentId(null);
                setTask("");
                setFollowUpText("");
              }}
              disabled={running}
            >
              New task
            </button>
          </div>
        )}

        {/* P2 — the session stays conversational: after done/stopped the input
            stays open and Enter continues the SAME session (same sandbox root,
            full context). "New task" above is the explicit fresh start. */}
        {agentId && (runState === "done" || runState === "stopped") ? (
          <div className="agent-followup">
            <textarea
              className="agent-task-input"
              placeholder="Follow up — same workspace, same context…"
              value={followUpText}
              onChange={(e) => setFollowUpText(e.target.value)}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendFollowUp();
                }
              }}
            />
            <button
              type="button"
              className="agent-launch-btn"
              onClick={() => void sendFollowUp()}
              disabled={!followUpText.trim() || running}
            >
              Continue session
            </button>
          </div>
        ) : null}

        {pending.map((p) => (
          <div className="agent-gate" key={String(p.approval_id)}>
            <div className="agent-gate-head">
              <span className="agent-gate-badge">Waiting on you</span>
              <span className="agent-gate-what">
                <strong>{String(p.tool)}</strong> wants to touch{" "}
                <code>{String(p.path)}</code>
              </span>
            </div>
            <pre className="agent-gate-diff">{String(p.diff)}</pre>
            <div className="agent-gate-actions">
              <button
                type="button"
                className="agent-approve"
                onClick={() => approve(String(p.approval_id), true)}
              >
                Approve
              </button>
              <button
                type="button"
                className="agent-decline"
                onClick={() => approve(String(p.approval_id), false)}
              >
                Decline
              </button>
            </div>
          </div>
        ))}

        <div className="agent-log" ref={logRef} aria-live="polite">
          {events.length === 0 ? (
            <p className="agent-log-empty">
              The run appears here — routing, the agent&apos;s reasoning, each tool
              call and result, approvals, and the final change summary.
            </p>
          ) : (
            events.map((e) => <LogLine key={e.seq} event={e} />)
          )}
        </div>
      </div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  tone,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  tone?: "warn";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`agent-switch${checked ? " on" : ""}${tone === "warn" ? " warn" : ""}`}
    >
      <span className="agent-switch-track" aria-hidden>
        <span className="agent-switch-thumb" />
      </span>
      <span className="agent-switch-text">
        <span className="agent-switch-label">{label}</span>
        {hint ? <span className="agent-switch-hint">{hint}</span> : null}
      </span>
    </button>
  );
}

function LogLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "started": {
      // Every exchange opens with a divider so multi-turn history reads as
      // Exchange 1 / Exchange 2 / … (exchange is 0-based on the wire).
      const exchangeNo = (typeof event.exchange === "number" ? event.exchange : 0) + 1;
      return (
        <>
          <p className="agent-ev agent-ev--divider" aria-hidden>
            ── Exchange {exchangeNo} ──────────────────
          </p>
          <p className="agent-ev agent-ev--start">
            <span className="agent-ev-rail" />
            {event.follow_up ? (
              <>↩ follow-up <code>{String(event.task ?? "")}</code></>
            ) : (
              <>▶ sandbox <code>{String(event.root)}</code></>
            )}
          </p>
        </>
      );
    }
    case "routed":
      return (
        <p className="agent-ev agent-ev--muted">
          <span className="agent-ev-rail" />→ {String(event.provider ?? "?")}
          {event.model ? ` · ${String(event.model)}` : ""}
        </p>
      );
    case "text":
      return <span className="agent-ev-text">{String(event.text)}</span>;
    case "turn_end":
      return <span className="agent-ev-break" />;
    case "tool_call":
      return (
        <p className="agent-ev agent-ev--tool">
          <span className="agent-ev-rail" />
          {String(event.tool)}
          <span className="agent-ev-args">({JSON.stringify(event.arguments)})</span>
        </p>
      );
    case "tool_result":
      return (
        <p className={`agent-ev ${event.is_error ? "agent-ev--warn" : "agent-ev--muted"}`}>
          <span className="agent-ev-rail" />
          {event.is_error ? "! " : "✓ "}
          {String(event.tool)} → {String(event.content).slice(0, 220)}
        </p>
      );
    case "approval_required":
      return (
        <p className="agent-ev agent-ev--gate">
          <span className="agent-ev-rail" />⏸ approval — {String(event.tool)}{" "}
          {String(event.path)}
        </p>
      );
    case "approval_resolved":
      return (
        <p className="agent-ev agent-ev--muted">
          <span className="agent-ev-rail" />
          {event.approved ? "✓ approved" : "✗ declined"}
          {event.auto ? " (auto)" : ""}
        </p>
      );
    case "done":
      return (
        <p className="agent-ev agent-ev--done">
          <span className="agent-ev-rail" />✓ done · {String(event.rounds)} round(s) ·{" "}
          {Number(event.mutations) === 0 ? "read only" : `${String(event.mutations)} change(s)`}
        </p>
      );
    case "stopped":
      return (
        <p className="agent-ev agent-ev--warn">
          <span className="agent-ev-rail" />⏹ stopped
        </p>
      );
    case "error":
      return (
        <p className="agent-ev agent-ev--error">
          <span className="agent-ev-rail" />✗ {String(event.message)}
        </p>
      );
    default:
      return null;
  }
}
