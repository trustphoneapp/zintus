import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Validates docs/openapi.yaml as a real OpenAPI 3.1 document AND cross-checks
// that every documented path is actually served by handler.ts (so the spec can
// not silently drift from the routes). No external deps: Bun ships a built-in
// YAML parser (`Bun.YAML.parse`). `Bun.YAML` is not in @types/bun yet, so it is
// accessed through a narrow typed shim rather than `any`.
const yaml = (Bun as unknown as { YAML: { parse(input: string): unknown } })
  .YAML;

const repoRoot = join(import.meta.dir, "..", "..", "..");
const specPath = join(repoRoot, "docs", "openapi.yaml");
const handlerPath = join(import.meta.dir, "handler.ts");

const rawSpec = readFileSync(specPath, "utf8");
const handlerSource = readFileSync(handlerPath, "utf8");

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    securitySchemes?: Record<string, { type: string; scheme?: string }>;
    schemas?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
}

interface OpenApiOperation {
  responses: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options"];

describe("docs/openapi.yaml", () => {
  test("parses as valid YAML", () => {
    expect(() => yaml.parse(rawSpec)).not.toThrow();
  });

  const spec = yaml.parse(rawSpec) as OpenApiDoc;

  test("is OpenAPI 3.1 with required top-level fields", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info?.title).toBe("Zintus Gateway API");
    expect(typeof spec.info?.version).toBe("string");
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  test("declares a bearer security scheme and a global default", () => {
    const scheme = spec.components?.securitySchemes?.bearerAuth;
    expect(scheme?.type).toBe("http");
    expect(scheme?.scheme).toBe("bearer");
    // Global default requires auth; /health opts out explicitly (see below).
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  test("every operation has at least one response", () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        expect(
          Object.keys(op.responses).length,
          `${method.toUpperCase()} ${path} has no responses`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("all $ref targets resolve within the document", () => {
    const refs = rawSpec.match(/\$ref:\s*"([^"]+)"/g) ?? [];
    for (const raw of refs) {
      const pointer = raw.replace(/\$ref:\s*"/, "").replace(/"$/, "");
      expect(pointer.startsWith("#/"), `external ref not allowed: ${pointer}`).toBe(true);
      const segments = pointer.slice(2).split("/");
      let node: unknown = spec;
      for (const seg of segments) {
        // JSON-pointer un-escape.
        const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
        node = (node as Record<string, unknown>)?.[key];
        expect(node, `unresolved $ref: ${pointer}`).toBeDefined();
      }
    }
  });

  // ── Cross-check: documented paths ⊆ real handler routes ──────────────────
  // Map each documented OpenAPI path to the literal the handler matches on.
  // Templated paths ({id}) are matched by their startsWith() prefix.
  const pathToHandlerLiteral: Record<string, string> = {
    "/health": '"/health"',
    "/v1/handshake": '"/v1/handshake"',
    "/metrics": '"/metrics"',
    "/v1/chat/completions": '"/v1/chat/completions"',
    "/v1/research": '"/v1/research"',
    "/v1/mcp/discover": '"/v1/mcp/discover"',
    "/v1/mcp": '"/v1/mcp"',
    "/v1/mcp/disconnect": '"/v1/mcp/disconnect"',
    "/v1/status": '"/v1/status"',
    "/v1/route/options": '"/v1/route/options"',
    "/v1/models": '"/v1/models"',
    "/v1/pricing": '"/v1/pricing"',
    "/v1/savings": '"/v1/savings"',
    "/v1/activity": '"/v1/activity"',
    "/v1/key": '"/v1/key"',
    "/v1/traces": '"/v1/traces"',
    "/v1/traces/last": '"/v1/traces/last"',
    "/v1/traces/{id}": '"/v1/traces/"', // handler: url.pathname.startsWith("/v1/traces/")
    "/v1/threads": '"/v1/threads"',
    "/v1/threads/{id}/state": '"/v1/threads/"', // startsWith("/v1/threads/") + endsWith("/state")
    "/v1/threads/{id}/compile": '"/v1/threads/"',
    "/v1/threads/{id}/messages": '"/v1/threads/"',
    "/v1/threads/{id}/memory": '"/v1/threads/"', // startsWith("/v1/threads/") + endsWith("/memory")
    "/v1/memory": '"/v1/memory"',
    "/v1/transcribe": '"/v1/transcribe"',
    "/v1/keys/validate": '"/v1/keys/validate"',
    "/v1/memory/{id}": '"/v1/memory/"', // startsWith("/v1/memory/")
    "/v1/compile/traces/{id}": '"/v1/compile/traces/"', // startsWith("/v1/compile/traces/")
    // Durable Zintus Engineer workflow.
    "/v1/engineer/readiness": '"/v1/engineer/readiness"',
    "/v1/engineer/readiness/retry": '"/v1/engineer/readiness/retry"',
    "/v1/engineer/observability": '"/v1/engineer/observability"',
    "/v1/engineer/repository": '"/v1/engineer/repository"',
    "/v1/engineer/repositories": '"/v1/engineer/repositories"',
    "/v1/engineer/runs": '"/v1/engineer/runs"',
    "/v1/engineer/runs/{runId}": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/plan": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/freeze-plan": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/start": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/recover-stale-base": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/events": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/artifacts": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/claims": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/evidence": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/evidence-export": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/tests": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/security": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/failures": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/git-operations": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/audit-export": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/decisions": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/decisions/{decisionId}/resolve": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/diff": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/approval": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/approve": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/request-changes": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/reject": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/extend-approval": '"/v1/engineer/runs/"',
    "/v1/engineer/runs/{runId}/cancel": '"/v1/engineer/runs/"',
    // P8 Publication Authority (handler.ts publication block:
    // `.includes("/publication-candidates")` / `.includes("/publications")`).
    "/v1/engineer/runs/{runId}/publication-candidates": '"/publication-candidates"',
    "/v1/engineer/publication-candidates/{checkpointId}/approvals": '"/publication-candidates"',
    "/v1/engineer/runs/{runId}/publications": '"/publications"',
    "/v1/engineer/publications/{publicationId}": '"/publications"',
    "/v1/engineer/publications/{publicationId}/dispatch": '"/publications"',
    "/v1/engineer/publications/{publicationId}/resume": '"/publications"',
    "/v1/engineer/publications/{publicationId}/reconcile": '"/publications"',
    "/v1/engineer/publications/{publicationId}/reconcile-discovery": '"/publications"',
    // R7-2 durable current-publication projection (handler.ts publication block:
    // `.includes("/current-publication")`).
    "/v1/engineer/runs/{runId}/current-publication": '"/current-publication"',
    // P7 Developer Resolution Desk (handler.ts resolution block: `.includes("/resolution-cases")`
    // + `startsWith("/v1/engineer/resolution-directives/")`).
    "/v1/engineer/runs/{runId}/resolution-cases": '"/resolution-cases"',
    "/v1/engineer/resolution-cases/{caseId}": '"/resolution-cases"',
    "/v1/engineer/resolution-cases/{caseId}/directives": '"/resolution-cases"',
    "/v1/engineer/resolution-directives/{directiveId}/apply": '"/v1/engineer/resolution-directives/"',
    // P2 gateway-hosted agent runtime (agents.ts, dispatched in handler.ts).
    "/v1/agents": '"/v1/agents"',
    "/v1/agents/{id}": '"/v1/agents/"', // startsWith("/v1/agents/")
    "/v1/agents/{id}/events": '"/v1/agents/"',
    "/v1/agents/{id}/approvals": '"/v1/agents/"',
    "/v1/agents/{id}/stop": '"/v1/agents/"',
    "/v1/agents/{id}/resume": '"/v1/agents/"',
    "/v1/agents/{id}/messages": '"/v1/agents/"', // POST follow-up (multi-turn)
  };

  test("every documented path is actually served by handler.ts", () => {
    for (const path of Object.keys(spec.paths)) {
      const literal = pathToHandlerLiteral[path];
      expect(literal, `spec documents an unmapped path: ${path}`).toBeDefined();
      expect(
        handlerSource.includes(literal ?? " "),
        `handler.ts does not serve documented path ${path} (looked for ${literal})`,
      ).toBe(true);
    }
  });

  test("documents every required public endpoint", () => {
    const required = [
      "/health",
      "/metrics",
      "/v1/chat/completions",
      "/v1/research",
      "/v1/status",
      "/v1/models",
      "/v1/pricing",
      "/v1/savings",
      "/v1/activity",
      "/v1/key",
      "/v1/traces",
      "/v1/traces/last",
      "/v1/traces/{id}",
      "/v1/threads",
      "/v1/threads/{id}/state",
      "/v1/threads/{id}/compile",
      "/v1/threads/{id}/messages",
      "/v1/compile/traces/{id}",
    ];
    for (const path of required) {
      expect(spec.paths[path], `missing required path ${path}`).toBeDefined();
    }
  });

  // ── Bidirectional anti-drift: every real handler route is documented ─────
  // The forward check above (documented ⊆ handler) won't catch a NEW route
  // added to handler.ts but left undocumented. This reverse check scans the
  // handler for its routing literals and asserts each is either documented or
  // explicitly allow-listed (with a reason). Keep INTENTIONALLY_OMITTED empty:
  // a non-empty entry is a deliberate, reviewed decision to NOT publish a route.
  const INTENTIONALLY_OMITTED: Record<string, string> = {
    // (empty) — all public routes are documented.
  };

  test("every handler route is documented (or explicitly omitted)", () => {
    const exactRoutes = [
      ...handlerSource.matchAll(/url\.pathname === "([^"]+)"/g),
    ].map((m) => m[1] as string);
    const prefixRoutes = [
      ...handlerSource.matchAll(/url\.pathname\.startsWith\("([^"]+)"\)/g),
    ].map((m) => m[1] as string);

    // Sanity: the scan actually found the routes (guards against a regex that
    // silently matches nothing and makes this test vacuously pass).
    expect(exactRoutes).toContain("/v1/chat/completions");
    expect(prefixRoutes).toContain("/v1/traces/");

    const documented = Object.keys(spec.paths);

    for (const route of new Set(exactRoutes)) {
      if (route in INTENTIONALLY_OMITTED) continue;
      // Exact-match handler route → must be an exact documented path.
      expect(
        documented.includes(route),
        `handler serves "${route}" (exact) but it is not documented in the spec`,
      ).toBe(true);
    }

    for (const prefix of new Set(prefixRoutes)) {
      if (prefix in INTENTIONALLY_OMITTED) continue;
      // Prefix (startsWith) handler route → at least one documented templated
      // path must live under that prefix.
      expect(
        documented.some((p) => p.startsWith(prefix)),
        `handler serves the "${prefix}*" route family but no documented path covers it`,
      ).toBe(true);
    }
  });

  // ── Auth accuracy ────────────────────────────────────────────────────────
  test("/health is the only unauthenticated endpoint", () => {
    expect(spec.paths["/health"]?.get?.security).toEqual([]);
    // Sanity: an auth-gated endpoint does NOT override the global security.
    expect(spec.paths["/v1/status"]?.get?.security).toBeUndefined();
  });

  // ── Contract fidelity (mirrors contracts.test.ts deviations) ─────────────
  test("ChatCompletion omits OpenAI's created/usage and uses chat.completion", () => {
    const schema = (spec.components?.schemas as Record<string, { const?: string; properties?: Record<string, unknown> }>)
      ?.ChatCompletion;
    const props = schema?.properties ?? {};
    expect(props.created).toBeUndefined();
    expect(props.usage).toBeUndefined();
    expect(props.provider).toBeDefined();
    expect(props.thread_id).toBeDefined();
    expect((props.object as { const?: string })?.const).toBe("chat.completion");
  });

  test("models a STRING error shape for the bare-string 404 routes", () => {
    expect(spec.components?.schemas?.StringError).toBeDefined();
  });

  // ── Provider accuracy: OpenAI is not a backend provider ──────────────────
  test("ProviderId enum is the 12 real providers and excludes openai", () => {
    const provider = (spec.components?.schemas as Record<string, { enum?: string[] }>)?.ProviderId;
    expect(provider?.enum).toEqual([
      "cerebras",
      "groq",
      "gemini",
      "openrouter",
      "cohere",
      "mistral",
      "deepseek",
      "fireworks",
      "xai",
      "huggingface",
      "lmstudio",
      "ollama",
    ]);
    expect(provider?.enum).not.toContain("openai");
  });

  // ── Security: no leaked secrets / real tokens in the spec ────────────────
  test("does not embed real-looking secrets or tokens", () => {
    // Known provider/key prefixes that must never appear as literal values.
    const secretPatterns = [
      /sk-[A-Za-z0-9]{16,}/, // OpenAI-style keys
      /gsk_[A-Za-z0-9]{16,}/, // Groq keys
      /tvly-[A-Za-z0-9]{16,}/, // Tavily keys
      /AIza[A-Za-z0-9_-]{20,}/, // Google API keys
      /Bearer\s+[A-Za-z0-9._-]{20,}/, // any concrete bearer value
    ];
    for (const pattern of secretPatterns) {
      expect(pattern.test(rawSpec), `spec leaks a secret matching ${pattern}`).toBe(false);
    }
  });
});
