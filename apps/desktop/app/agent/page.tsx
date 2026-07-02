"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAgentTask,
  resolveApproval,
  stopAgent,
  streamAgentEvents,
  type AgentEvent,
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

  const start = useCallback(async () => {
    if (!task.trim() || running) return;
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
  }, [task, root, allowRun, sandbox, browse, autoApprove, running]);

  const stop = useCallback(() => {
    if (agentId) void stopAgent(agentId);
  }, [agentId]);

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

      <div className="agent-body">
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
                disabled={!armed}
              >
                {armed ? "Launch agent" : "Enter a task to launch"}
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
                setEvents([]);
                setError(null);
              }}
              disabled={running}
            >
              New task
            </button>
          </div>
        )}

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
    case "started":
      return (
        <p className="agent-ev agent-ev--start">
          <span className="agent-ev-rail" />▶ sandbox <code>{String(event.root)}</code>
        </p>
      );
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
          {String(event.mutations)} change(s)
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
