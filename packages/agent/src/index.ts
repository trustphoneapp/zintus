// @zintus/agent — the surface-agnostic agent runtime (P2 of the OpenRouter×Manus
// plan). Extracted VERBATIM from apps/cli/src/lib on 2026-07-02 so the same
// hardened single-writer loop (B1 tokzen context management, B2 strategy seam,
// B3 verify→revise, B4 edit ladder, B5 notes, B6 repo map) can be hosted by the
// gateway (`/v1/agents`) and driven by every surface — the CLI keeps using it
// in-process. No behavior changed in the move; the git history of these files
// continues from apps/cli/src/lib/.
export * from "./agent-tools.js";
export * from "./agent-mcp.js";
export * from "./builtin-tools.js";
export * from "./route-request.js";
export * from "./preamble.js";
export * from "./sandbox-docker.js";
export * from "./browser-tool.js";
