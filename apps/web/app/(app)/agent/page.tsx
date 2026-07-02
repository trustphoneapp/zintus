"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAgentTask,
  resolveApproval,
  stopAgent,
  streamAgentEvents,
  type AgentEvent,
} from "@/lib/agents";

/**
 * Agent mode (P2): drive the gateway-hosted coding agent from the browser.
 * The agent runs ON YOUR MACHINE (the gateway host), confined to the sandbox
 * root; every file write / command run pauses here for your explicit approval
 * unless you check auto-approve. The phone gets the same surface via the relay.
 */
export default function AgentPage() {
  const [task, setTask] = useState("");
  const [root, setRoot] = useState("");
  const [allowRun, setAllowRun] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
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
        // Docker sandbox is only meaningful with allowRun (it isolates run_command).
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
  }, [task, root, allowRun, autoApprove, sandbox, browse, running]);

  const stop = useCallback(() => {
    if (agentId) void stopAgent(agentId);
  }, [agentId]);

  const approve = useCallback(
    (approvalId: string, approved: boolean) => {
      if (agentId) void resolveApproval(agentId, approvalId, approved);
    },
    [agentId],
  );

  // Approvals still pending = required minus resolved.
  const resolved = new Set(
    events
      .filter((e) => e.type === "approval_resolved")
      .map((e) => String(e.approval_id)),
  );
  const pending = events.filter(
    (e) => e.type === "approval_required" && !resolved.has(String(e.approval_id)),
  );

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Agent</h1>
        <p className="text-sm text-neutral-400">
          Runs on your gateway machine, sandboxed to the root below. Writes and
          commands pause for your approval.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <textarea
          className="min-h-24 rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-sm"
          placeholder="Task — e.g. “add a --json flag to the export script”"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          disabled={running}
        />
        <input
          className="rounded-lg border border-neutral-700 bg-neutral-900 p-2 text-sm"
          placeholder="Sandbox root on the gateway host (default: gateway workspace)"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          disabled={running}
        />
        <div className="flex flex-wrap items-center gap-4 text-sm text-neutral-300">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allowRun}
              onChange={(e) => setAllowRun(e.target.checked)}
              disabled={running}
            />
            Allow verify commands (bun test/typecheck…)
          </label>
          <label
            className={`flex items-center gap-2 ${allowRun ? "" : "opacity-40"}`}
            title={allowRun ? "" : "Requires Allow verify commands"}
          >
            <input
              type="checkbox"
              checked={sandbox}
              onChange={(e) => setSandbox(e.target.checked)}
              disabled={running || !allowRun}
            />
            Docker sandbox
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={browse}
              onChange={(e) => setBrowse(e.target.checked)}
              disabled={running}
            />
            Browser tool
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              disabled={running}
            />
            Auto-approve writes (careful)
          </label>
          <div className="ml-auto flex gap-2">
            {running ? (
              <button
                className="rounded-lg border border-red-500 px-4 py-1.5 text-red-400"
                onClick={stop}
              >
                Stop
              </button>
            ) : (
              <button
                className="rounded-lg bg-emerald-600 px-4 py-1.5 font-medium text-white disabled:opacity-40"
                onClick={() => void start()}
                disabled={!task.trim()}
              >
                Run agent
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-neutral-500">
          Docker sandbox and the browser tool run on the gateway host and need
          Docker / Playwright installed there — if absent, the agent proceeds
          without them (no silent failure). Browsing blocks private/internal
          hosts by default.
        </p>
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {pending.map((p) => (
        <div
          key={String(p.approval_id)}
          className="rounded-lg border border-amber-500 bg-amber-950/40 p-3 text-sm"
        >
          <p className="font-medium text-amber-300">
            {String(p.tool)} wants to touch {String(p.path)}
          </p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-300">
            {String(p.diff)}
          </pre>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-emerald-600 px-3 py-1 text-white"
              onClick={() => approve(String(p.approval_id), true)}
            >
              Approve
            </button>
            <button
              className="rounded border border-neutral-600 px-3 py-1"
              onClick={() => approve(String(p.approval_id), false)}
            >
              Decline
            </button>
          </div>
        </div>
      ))}

      <div
        ref={logRef}
        className="flex-1 overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-relaxed"
      >
        {events.length === 0 ? (
          <p className="text-neutral-500">
            Events will stream here — routing, the agent&apos;s text, tool calls
            and results, approvals, and the final change summary.
          </p>
        ) : (
          events.map((e) => <EventLine key={e.seq} event={e} />)
        )}
      </div>
    </div>
  );
}

function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "started":
      return (
        <p className="text-cyan-400">
          ▶ sandbox {String(event.root)} · max {String(event.max_rounds)} rounds
        </p>
      );
    case "routed":
      return (
        <p className="text-neutral-500">
          → routed to {String(event.provider ?? "?")}
          {event.model ? ` · ${String(event.model)}` : ""}
        </p>
      );
    case "text":
      return <span className="whitespace-pre-wrap text-neutral-200">{String(event.text)}</span>;
    case "turn_end":
      return <br />;
    case "tool_call":
      return (
        <p className="text-blue-400">
          🔧 {String(event.tool)}({JSON.stringify(event.arguments)})
        </p>
      );
    case "tool_result":
      return (
        <p className={event.is_error ? "text-amber-400" : "text-neutral-500"}>
          {event.is_error ? "⚠ " : "✓ "}
          {String(event.tool)} → {String(event.content).slice(0, 200)}
        </p>
      );
    case "approval_required":
      return (
        <p className="text-amber-300">
          ⏸ approval required: {String(event.tool)} → {String(event.path)}
        </p>
      );
    case "approval_resolved":
      return (
        <p className="text-neutral-500">
          {event.approved ? "✔ approved" : "✖ declined"}
          {event.auto ? " (auto)" : ""}
        </p>
      );
    case "done":
      return (
        <p className="text-emerald-400">
          ✅ done · {String(event.rounds)} round(s) · {String(event.mutations)}{" "}
          change(s)
        </p>
      );
    case "stopped":
      return <p className="text-red-400">⏹ stopped</p>;
    case "error":
      return <p className="text-red-400">✗ {String(event.message)}</p>;
    default:
      return null;
  }
}
