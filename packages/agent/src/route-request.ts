import type {
  ChatMessage,
  ContextMode,
  RoutingStrategy,
  ToolDefinition,
} from "@zintus/types";

/**
 * B2 — the per-call routing strategy SEAM. Builds the RouteRequest for one
 * agent turn, threading a routing `strategy` WITHOUT hardcoding a
 * provider/model — so the router still picks the best/cheapest model across
 * all providers WITHIN the chosen tier. The main writer loop passes the user's
 * configured strategy (honest: we never silently override an explicit
 * "fastest" with "quality"); internal/auxiliary callers (e.g. a cheap
 * triage/explorer) can request `"economy"`. The chosen strategy is already
 * surfaced in the engine's route-reason line. (Moved verbatim from
 * apps/cli/src/commands/agent.ts on 2026-07-02 — it is runtime contract, not
 * CLI driver code.)
 */
export function buildAgentRouteRequest(opts: {
  messages: ChatMessage[];
  mode: ContextMode;
  tools: ToolDefinition[];
  strategy: RoutingStrategy | "weighted";
}): {
  messages: ChatMessage[];
  mode: ContextMode;
  tools: ToolDefinition[];
  strategy: RoutingStrategy | "weighted";
} {
  return {
    messages: opts.messages,
    mode: opts.mode,
    tools: opts.tools,
    strategy: opts.strategy,
  };
}
