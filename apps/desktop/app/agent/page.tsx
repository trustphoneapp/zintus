"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAgentTask,
  resolveApproval,
  stopAgent,
  streamAgentEvents,
  type AgentEvent,
} from "@/lib/agents";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Textarea } from "@/app/_components/ui/textarea";

/**
 * Agent mode (desktop) — drives the gateway-hosted coding agent
 * (`/v1/agents`). The agent runs ON THIS MACHINE (the gateway host), confined
 * to the sandbox root; every file write / command pauses here for approval
 * unless auto-approve is on. This is the desktop's "My Computer" surface —
 * parity with the web `/agent` page.
 */
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

  const resolved = new Set(
    events
      .filter((e) => e.type === "approval_resolved")
      .map((e) => String(e.approval_id)),
  );
  const pending = events.filter(
    (e) => e.type === "approval_required" && !resolved.has(String(e.approval_id)),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 20, flex: 1, minHeight: 0 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Agent</h1>
        <p style={{ fontSize: 13, color: "var(--color-text-sub)", margin: "4px 0 0" }}>
          Runs on this machine (the gateway host), sandboxed to the root below.
          Writes and commands pause for your approval.
        </p>
      </div>

      <Card>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 16 }}>
          <Textarea
            placeholder="Task — e.g. “add a --json flag to the export script”"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={running}
            style={{ minHeight: 72 }}
          />
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="Sandbox root on the gateway host (default: gateway workspace)"
            disabled={running}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              background: "var(--color-bg)",
              color: "var(--color-text)",
              fontSize: 13,
            }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={allowRun} onChange={(e) => setAllowRun(e.target.checked)} disabled={running} />
              Allow verify commands
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, opacity: allowRun ? 1 : 0.4 }}>
              <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} disabled={running || !allowRun} />
              Docker sandbox
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={browse} onChange={(e) => setBrowse(e.target.checked)} disabled={running} />
              Browser tool
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} disabled={running} />
              Auto-approve writes
            </label>
            <div style={{ marginLeft: "auto" }}>
              {running ? (
                <Button type="button" variant="secondary" onClick={stop}>
                  Stop
                </Button>
              ) : (
                <Button type="button" onClick={() => void start()} disabled={!task.trim()}>
                  Run agent
                </Button>
              )}
            </div>
          </div>
          <p style={{ fontSize: 11, color: "var(--color-text-sub)", margin: 0 }}>
            Docker sandbox &amp; the browser tool need Docker / Playwright installed on
            the gateway host; if absent, the agent proceeds without them. Browsing
            blocks private/internal hosts by default.
          </p>
        </CardContent>
      </Card>

      {error ? <p style={{ color: "var(--color-red)", fontSize: 13 }}>{error}</p> : null}

      {pending.map((p) => (
        <Card key={String(p.approval_id)} style={{ borderColor: "var(--color-amber, #f59e0b)" }}>
          <CardHeader>
            <CardTitle style={{ fontSize: 14 }}>
              {String(p.tool)} wants to touch {String(p.path)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre style={{ maxHeight: 200, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", color: "var(--color-text-sub)" }}>
              {String(p.diff)}
            </pre>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button type="button" onClick={() => approve(String(p.approval_id), true)}>
                Approve
              </Button>
              <Button type="button" variant="secondary" onClick={() => approve(String(p.approval_id), false)}>
                Decline
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <div
        ref={logRef}
        style={{
          flex: 1,
          overflow: "auto",
          borderRadius: 10,
          border: "1px solid var(--color-border)",
          background: "var(--color-bg)",
          padding: 12,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {events.length === 0 ? (
          <p style={{ color: "var(--color-text-sub)" }}>
            Events stream here — routing, the agent&apos;s text, tool calls and
            results, approvals, and the final change summary.
          </p>
        ) : (
          events.map((e) => <EventLine key={e.seq} event={e} />)
        )}
      </div>
    </div>
  );
}

function EventLine({ event }: { event: AgentEvent }) {
  const sub = "var(--color-text-sub)";
  switch (event.type) {
    case "started":
      return <p style={{ color: "var(--color-purple-light)" }}>▶ sandbox {String(event.root)}</p>;
    case "routed":
      return <p style={{ color: sub }}>→ routed to {String(event.provider ?? "?")}{event.model ? ` · ${String(event.model)}` : ""}</p>;
    case "text":
      return <span style={{ whiteSpace: "pre-wrap", color: "var(--color-text)" }}>{String(event.text)}</span>;
    case "turn_end":
      return <br />;
    case "tool_call":
      return <p style={{ color: "#60a5fa" }}>🔧 {String(event.tool)}({JSON.stringify(event.arguments)})</p>;
    case "tool_result":
      return <p style={{ color: event.is_error ? "#f59e0b" : sub }}>{event.is_error ? "⚠ " : "✓ "}{String(event.tool)} → {String(event.content).slice(0, 200)}</p>;
    case "approval_required":
      return <p style={{ color: "#f59e0b" }}>⏸ approval required: {String(event.tool)} → {String(event.path)}</p>;
    case "approval_resolved":
      return <p style={{ color: sub }}>{event.approved ? "✔ approved" : "✖ declined"}{event.auto ? " (auto)" : ""}</p>;
    case "done":
      return <p style={{ color: "#34d399" }}>✅ done · {String(event.rounds)} round(s) · {String(event.mutations)} change(s)</p>;
    case "stopped":
      return <p style={{ color: "var(--color-red)" }}>⏹ stopped</p>;
    case "error":
      return <p style={{ color: "var(--color-red)" }}>✗ {String(event.message)}</p>;
    default:
      return null;
  }
}
