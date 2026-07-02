import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ChatMessage, RoutingStrategy, ContextMode } from "@zintus/types";
import {
  AGENT_TOOL_DEFINITIONS,
  DEFAULT_AGENT_ROUNDS,
  DEFAULT_MUTATION_BUDGET,
  DEFAULT_RUN_BUDGET,
  MAX_AGENT_ROUNDS_CAP,
  RUN_COMMAND_TOOL_NAME,
  buildAgentRouteRequest,
  buildAgentSystemPreamble,
  browserToolDefinition,
  buildRepoMap,
  createContextStore,
  createDockerSpawn,
  createPlanState,
  createSandbox,
  executeAgentToolCall,
  executeBrowseCall,
  loadPlaywrightDriver,
  runAgentToolLoop,
  type BrowserDriver,
  type AgentLoopHandlers,
  type AgentToolContext,
  type ChangeLogEntry,
  type ConfirmWrite,
  type ToolLoopTurn,
} from "@zintus/agent";

/**
 * Gateway-hosted agent runtime (P2 of the OpenRouter×Manus plan): the SAME
 * hardened loop the CLI runs (`@zintus/agent`), exposed as
 *   POST /v1/agents                    → { id }   (starts the run)
 *   GET  /v1/agents                    → task summaries
 *   GET  /v1/agents/:id                → one summary
 *   GET  /v1/agents/:id/events         → SSE (full backlog replay, then live)
 *   POST /v1/agents/:id/approvals      → resolve a pending write/run gate
 *   POST /v1/agents/:id/stop           → decline pending gates + stop at the
 *                                        next round boundary
 * so every surface (web/desktop/mobile-via-relay) can drive an agent that runs
 * on the user's own machine.
 *
 * SAFETY: the same trust boundary as `zintus agent` — file writes confined to
 * a sandbox root on the gateway host, every mutation confirm-gated. Over HTTP
 * the gate becomes an `approval_required` event + the approvals endpoint;
 * `autoApprove: true` (the --yes analog) must be sent EXPLICITLY per task.
 * These routes sit behind the same bearer auth as every other /v1 route.
 *
 * PARITY GAPS vs the CLI driver (deliberate v1, documented):
 *  - no MCP toolset (the CLI hosts user MCP servers in-process),
 *  - no automatic post-loop verify→revise controller (with `allowRun` the
 *    model can still run the allowlisted verify commands itself),
 *  - completed-run records persist to ~/.zintus/agents/<id>.json; a gateway
 *    restart does NOT resume an in-flight run (checkpoint/resume is the next
 *    slice).
 */

export interface AgentEvent {
  seq: number;
  ts: number;
  type:
    | "started"
    | "routed"
    | "text"
    | "turn_end"
    | "tool_call"
    | "tool_result"
    | "approval_required"
    | "approval_resolved"
    | "done"
    | "error"
    | "stopped";
  [key: string]: unknown;
}

export type AgentTaskStatus =
  | "running"
  | "awaiting_approval"
  | "done"
  | "error"
  | "stopped"
  // A run whose process died mid-flight (found non-terminal in the records dir
  // on startup). Resumable via POST /v1/agents/:id/resume.
  | "interrupted";

interface AgentTask {
  id: string;
  task: string;
  root: string;
  status: AgentTaskStatus;
  createdAt: number;
  events: AgentEvent[];
  listeners: Set<(e: AgentEvent) => void>;
  pendingApprovals: Map<
    string,
    { resolve: (approved: boolean) => void; toolName: string; path: string }
  >;
  stopRequested: boolean;
  rounds: number;
  /** The create body — persisted so an interrupted run can be resumed with the
   *  same sandbox/allowRun/strategy after a gateway restart. */
  body: CreateAgentTaskBody;
  /** Latest replay-safe conversation (updated each round boundary); the resume
   *  seed. Undefined until the first round completes. */
  checkpoint?: ChatMessage[];
}

/** How long an un-answered approval waits before it is DECLINED (fail closed). */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
/** Backlog cap per task — old text deltas are dropped first beyond this. */
const MAX_EVENTS = 10_000;

export interface CreateAgentTaskBody {
  task: string;
  /** Sandbox root on the gateway host. Default: ZINTUS_WORKSPACE or cwd. */
  root?: string;
  maxRounds?: number;
  /** Explicit --yes analog: auto-approve every write/run gate. */
  autoApprove?: boolean;
  /** Offer the allowlisted run_command tool to the model. */
  allowRun?: boolean;
  /** Run allowlisted commands inside a hardened Docker container (P3). Requires
   *  allowRun + a reachable Docker daemon on the gateway host. */
  sandbox?: boolean;
  /** Container image for `sandbox` (default oven/bun:1). */
  sandboxImage?: string;
  /** Offer the read-only `browse` tool (needs Playwright on the gateway host;
   *  silently unavailable to the model if the driver can't load). */
  browse?: boolean;
  /** Permit the browse tool to reach private/loopback/link-local hosts. OFF by
   *  default (SSRF guard) — only enable for trusted internal browsing. */
  browseAllowPrivate?: boolean;
  strategy?: RoutingStrategy | "weighted";
  mode?: ContextMode;
}

/** The minimal engine surface the agent host needs (structural, test-friendly). */
export interface AgentEngine {
  routeAndStream(request: {
    messages: ChatMessage[];
    mode?: ContextMode;
    tools?: unknown;
    strategy?: RoutingStrategy | "weighted";
  }): Promise<ToolLoopTurn & { threadId?: string }>;
}

function recordsDir(): string {
  return process.env.ZINTUS_AGENT_RECORDS ?? path.join(homedir(), ".zintus", "agents");
}

export class AgentTaskManager {
  private readonly tasks = new Map<string, AgentTask>();
  constructor(private readonly engine: AgentEngine) {
    this.recoverInterrupted();
  }

  /**
   * On startup, scan the records dir for runs that never reached a terminal
   * status (the process died mid-flight) and re-register them as `interrupted`
   * so they show up in the list and can be resumed. Best-effort: a malformed
   * record is skipped, never fatal.
   */
  private recoverInterrupted(): void {
    let files: string[];
    try {
      files = readdirSync(recordsDir()).filter((f) => f.endsWith(".json"));
    } catch {
      return; // no records dir yet
    }
    for (const f of files) {
      try {
        const raw = JSON.parse(
          readFileSync(path.join(recordsDir(), f), "utf8"),
        ) as Partial<AgentTask> & { status?: AgentTaskStatus };
        if (!raw.id) continue;
        // Already terminal → nothing to resume; leave it on disk as a record.
        if (
          raw.status === "done" ||
          raw.status === "error" ||
          raw.status === "stopped"
        ) {
          continue;
        }
        this.tasks.set(raw.id, {
          id: raw.id,
          task: raw.task ?? "",
          root: raw.root ?? "",
          status: "interrupted",
          createdAt: raw.createdAt ?? Date.now(),
          events: Array.isArray(raw.events) ? raw.events : [],
          listeners: new Set(),
          pendingApprovals: new Map(),
          stopRequested: false,
          rounds: raw.rounds ?? 0,
          body: raw.body ?? { task: raw.task ?? "" },
          checkpoint: raw.checkpoint,
        });
      } catch {
        // skip a malformed record
      }
    }
  }

  list(): Array<Record<string, unknown>> {
    return [...this.tasks.values()].map((t) => this.summary(t));
  }

  get(id: string): Record<string, unknown> | null {
    const t = this.tasks.get(id);
    return t ? this.summary(t) : null;
  }

  private summary(t: AgentTask) {
    return {
      id: t.id,
      task: t.task.length > 200 ? `${t.task.slice(0, 197)}…` : t.task,
      root: t.root,
      status: t.status,
      created_at: t.createdAt,
      rounds: t.rounds,
      events: t.events.length,
      pending_approvals: [...t.pendingApprovals.entries()].map(([id, p]) => ({
        id,
        tool: p.toolName,
        path: p.path,
      })),
    };
  }

  private emit(
    t: AgentTask,
    event: { type: AgentEvent["type"] } & Record<string, unknown>,
  ): void {
    const e: AgentEvent = { ...event, seq: t.events.length, ts: Date.now() };
    t.events.push(e);
    if (t.events.length > MAX_EVENTS) {
      // Drop oldest text deltas first; structural events are kept.
      const idx = t.events.findIndex((x) => x.type === "text");
      if (idx >= 0) t.events.splice(idx, 1);
    }
    for (const fn of t.listeners) fn(e);
  }

  /** SSE stream: replay the full backlog, then live events until terminal. */
  subscribe(id: string): ReadableStream<Uint8Array> | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    const enc = new TextEncoder();
    let listener: ((e: AgentEvent) => void) | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (e: AgentEvent) => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          if (e.type === "done" || e.type === "error" || e.type === "stopped") {
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            if (listener) t.listeners.delete(listener);
            controller.close();
          }
        };
        for (const e of [...t.events]) send(e);
        if (
          t.status === "running" ||
          t.status === "awaiting_approval"
        ) {
          listener = send;
          t.listeners.add(listener);
        }
      },
      cancel: () => {
        if (listener) t.listeners.delete(listener);
      },
    });
  }

  approve(taskId: string, approvalId: string, approved: boolean): boolean {
    const t = this.tasks.get(taskId);
    const pending = t?.pendingApprovals.get(approvalId);
    if (!t || !pending) return false;
    t.pendingApprovals.delete(approvalId);
    if (t.pendingApprovals.size === 0 && t.status === "awaiting_approval") {
      t.status = "running";
    }
    this.emit(t, { type: "approval_resolved", approval_id: approvalId, approved });
    pending.resolve(approved);
    return true;
  }

  stop(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    t.stopRequested = true;
    // Fail every pending gate closed so the loop can advance to the stop check.
    for (const [aid, p] of [...t.pendingApprovals.entries()]) {
      t.pendingApprovals.delete(aid);
      this.emit(t, { type: "approval_resolved", approval_id: aid, approved: false });
      p.resolve(false);
    }
    return true;
  }

  create(body: CreateAgentTaskBody): { id: string } {
    const root = body.root ?? process.env.ZINTUS_WORKSPACE ?? process.cwd();
    if (!existsSync(root)) {
      throw new Error(`Sandbox root does not exist on the gateway host: ${root}`);
    }
    const sandbox = createSandbox(root); // throws on an invalid root
    const t: AgentTask = {
      id: randomUUID(),
      task: body.task,
      root: sandbox.root,
      status: "running",
      createdAt: Date.now(),
      events: [],
      listeners: new Set(),
      pendingApprovals: new Map(),
      stopRequested: false,
      rounds: 0,
      body,
    };
    this.tasks.set(t.id, t);
    void this.run(t, sandbox, body).catch((error) => {
      t.status = "error";
      this.emit(t, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { id: t.id };
  }

  /**
   * Resume an `interrupted` run from its last round-boundary checkpoint. Re-runs
   * the SAME loop with the checkpointed conversation as the seed, so the model
   * continues from where it left off. Refuses when the task is not interrupted
   * or has no checkpoint (nothing safe to resume from).
   */
  resume(id: string): { ok: true } | { ok: false; reason: string } {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, reason: "agent not found" };
    if (t.status !== "interrupted") {
      return { ok: false, reason: `task is ${t.status}, not interrupted` };
    }
    if (!t.checkpoint || t.checkpoint.length === 0) {
      return { ok: false, reason: "no resumable checkpoint (run never completed a round)" };
    }
    let sandbox: ReturnType<typeof createSandbox>;
    try {
      sandbox = createSandbox(t.root);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    t.status = "running";
    t.stopRequested = false;
    this.emit(t, { type: "started", resumed: true, root: t.root });
    void this.run(t, sandbox, t.body, t.checkpoint).catch((error) => {
      t.status = "error";
      this.emit(t, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { ok: true };
  }

  private confirmGate(t: AgentTask, autoApprove: boolean): ConfirmWrite {
    if (autoApprove) {
      return async ({ toolName, path: p }) => {
        this.emit(t, {
          type: "approval_resolved",
          approval_id: null,
          approved: true,
          auto: true,
          tool: toolName,
          path: p,
        });
        return true;
      };
    }
    return async ({ toolName, path: p, diff }) => {
      if (t.stopRequested) return false;
      const approvalId = randomUUID();
      const promise = new Promise<boolean>((resolve) => {
        t.pendingApprovals.set(approvalId, { resolve, toolName, path: p });
      });
      t.status = "awaiting_approval";
      this.emit(t, {
        type: "approval_required",
        approval_id: approvalId,
        tool: toolName,
        path: p,
        diff,
      });
      const timer = setTimeout(() => {
        // Fail closed on timeout; harmless if already resolved.
        this.approve(t.id, approvalId, false);
      }, APPROVAL_TIMEOUT_MS);
      const approved = await promise;
      clearTimeout(timer);
      if (t.status === "awaiting_approval" && t.pendingApprovals.size === 0) {
        t.status = "running";
      }
      return approved;
    };
  }

  private async run(
    t: AgentTask,
    sandbox: ReturnType<typeof createSandbox>,
    body: CreateAgentTaskBody,
    /** Resume seed: the checkpointed conversation to continue from (undefined =
     *  a fresh run built from the preamble + task). */
    resumeConvo?: ChatMessage[],
  ): Promise<void> {
    const maxRounds = Math.min(
      Math.max(1, body.maxRounds ?? DEFAULT_AGENT_ROUNDS),
      MAX_AGENT_ROUNDS_CAP,
    );
    const allowRun = body.allowRun ?? false;
    const fileTools = allowRun
      ? AGENT_TOOL_DEFINITIONS
      : AGENT_TOOL_DEFINITIONS.filter((d) => d.name !== RUN_COMMAND_TOOL_NAME);
    // P3 browser tool: offered only when a Playwright driver actually loads
    // (graceful absence — no fake capability). Read-only navigation, so it is
    // NOT confirm-gated, but it is disabled entirely without the driver.
    const browser: BrowserDriver | null = body.browse
      ? await loadPlaywrightDriver().catch(() => null)
      : null;
    const toolDefinitions = browser
      ? [...fileTools, browserToolDefinition]
      : fileTools;

    const changeLog: ChangeLogEntry[] = [];
    const ccrStore = createContextStore();
    const ctx: AgentToolContext = {
      sandbox,
      confirm: this.confirmGate(t, body.autoApprove ?? false),
      budget: { used: 0, max: DEFAULT_MUTATION_BUDGET },
      plan: createPlanState(),
      changeLog,
      context: {
        store: ccrStore,
        sessionId: `agents-${t.id.slice(0, 8)}`,
      },
      run: allowRun
        ? {
            allow: true,
            budget: { used: 0, max: DEFAULT_RUN_BUDGET },
            ...(body.sandbox
              ? { spawn: createDockerSpawn({ image: body.sandboxImage }) }
              : {}),
          }
        : undefined,
      semantic: {},
    };

    let repoMap = "";
    try {
      repoMap = buildRepoMap(sandbox.root).text;
    } catch {
      repoMap = "";
    }
    // Resume from the checkpointed conversation when present, else start fresh.
    const initialMessages: ChatMessage[] =
      resumeConvo && resumeConvo.length > 0
        ? resumeConvo
        : [
            {
              role: "user",
              content: `${buildAgentSystemPreamble(sandbox.root, 0, allowRun, repoMap)}\n\n---\n\nTask:\n${t.task}`,
            },
          ];

    if (!resumeConvo) {
      this.emit(t, {
        type: "started",
        root: sandbox.root,
        max_rounds: maxRounds,
        allow_run: allowRun,
        auto_approve: body.autoApprove ?? false,
      });
    }

    const handlers: AgentLoopHandlers<ToolLoopTurn> = {
      maxRounds,
      route: async (messages) => {
        if (t.stopRequested) throw new Error("stopped");
        return this.engine.routeAndStream(
          buildAgentRouteRequest({
            messages,
            mode: body.mode ?? "smart",
            tools: toolDefinitions,
            strategy: body.strategy ?? "balanced",
          }),
        );
      },
      execute: (call) =>
        call.name === "browse"
          ? executeBrowseCall(
              { id: call.id, arguments: call.arguments },
              browser ?? undefined,
              { allowPrivate: body.browseAllowPrivate ?? false },
            )
          : executeAgentToolCall(
              { id: call.id, name: call.name, arguments: call.arguments },
              ctx,
            ),
      onRouted: async (turn, round) => {
        t.rounds = round + 1;
        const meta = turn as { providerId?: string; model?: string; traceId?: string };
        this.emit(t, {
          type: "routed",
          round,
          provider: meta.providerId,
          model: meta.model,
          trace_id: meta.traceId,
        });
      },
      onChunk: (chunk) => this.emit(t, { type: "text", text: chunk }),
      onTurnEnd: () => this.emit(t, { type: "turn_end" }),
      onToolCalls: (calls) => {
        for (const c of calls) {
          this.emit(t, {
            type: "tool_call",
            id: c.id,
            tool: c.name,
            // Full arguments ride on the tool_call event for the driving UI
            // (they never include provider keys — the agent has no key access).
            arguments: c.arguments,
          });
        }
      },
      onToolResult: async (r, call) => {
        this.emit(t, {
          type: "tool_result",
          id: r.toolCallId,
          tool: call.name,
          is_error: r.isError,
          content:
            r.content.length > 4000 ? `${r.content.slice(0, 4000)}…` : r.content,
          plan: ctx.plan?.steps,
        });
      },
      // Durable round-boundary checkpoint: capture the replay-safe conversation
      // so a gateway restart can resume this run (recoverInterrupted + resume()).
      onRoundComplete: (convo, round) => {
        t.checkpoint = convo;
        t.rounds = round + 1;
        this.persist(t);
      },
      context: {
        store: ccrStore,
        sessionId: `agents-${t.id.slice(0, 8)}`,
      },
    };

    try {
      const { rounds } = await runAgentToolLoop(initialMessages, handlers);
      t.rounds = rounds;
      t.status = t.stopRequested ? "stopped" : "done";
      this.emit(t, {
        type: t.stopRequested ? "stopped" : "done",
        rounds,
        mutations: ctx.budget.used,
        changes: changeLog.map((c) => ({ path: c.path, tool: c.tool })),
      });
    } catch (error) {
      if (t.stopRequested) {
        t.status = "stopped";
        this.emit(t, { type: "stopped", rounds: t.rounds });
      } else {
        t.status = "error";
        this.emit(t, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      try {
        ccrStore.close();
      } catch {
        // best-effort
      }
      this.persist(t);
    }
  }

  /** Best-effort durable record. Written each round (for resume) AND on
   *  terminal state (for review). Includes `body` + `checkpoint` so an
   *  interrupted run can be reconstructed and resumed after a restart. */
  private persist(t: AgentTask): void {
    try {
      const dir = recordsDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${t.id}.json`),
        JSON.stringify(
          {
            id: t.id,
            task: t.task,
            root: t.root,
            status: t.status,
            createdAt: t.createdAt,
            rounds: t.rounds,
            events: t.events,
            body: t.body,
            checkpoint: t.checkpoint,
          },
          null,
          2,
        ),
      );
    } catch {
      // Durable record is best-effort; the live API remains the source of truth.
    }
  }
}
