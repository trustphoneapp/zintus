/**
 * Pure, dependency-free helpers for WEB structured output (the `{}` control in
 * the chat composer). They translate the user's chosen mode + pasted schema INTO
 * a model `ResponseFormat` (the exact flat shape the gateway/engine already
 * accept — see packages/types `ResponseFormat`), parse a structured response for
 * the JSON render surface, and locally validate a response against the schema.
 *
 * HONESTY (mirrors apps/cli chat-content `buildResponseFormat` /
 * STRUCTURED_GUARANTEE_CAVEAT): only **Gemini** can GUARANTEE `json_schema`
 * conformance. For every other provider a `json_schema` request degrades to
 * native `json_object` or prompt coercion — best-effort, validated locally, never
 * guaranteed. We never send a broken schema: `buildResponseFormat` returns an
 * `error` instead of a `responseFormat` when the pasted schema isn't well-formed.
 *
 * Kept side-effect-free so it is unit-testable on its own (no React, no DOM).
 */
import type { JsonSchema, ResponseFormat } from "@zintus/types";

/** The three structured-output modes the web control exposes. `off` = plain text
 *  (unchanged default); `json_object` = the original toggle; `json_schema` = paste
 *  a JSON Schema and ask the provider to conform to it. */
export type StructuredMode = "off" | "json_object" | "json_schema";

/** localStorage keys — persisted like `zintus:web-search` / `zintus:tools`. */
export const STRUCTURED_MODE_KEY = "zintus:json-mode";
export const STRUCTURED_SCHEMA_KEY = "zintus:json-schema";
/** Legacy boolean toggle, migrated to `json_object` mode on first read. */
export const LEGACY_JSON_KEY = "zintus:json";

/** The honesty caveat surfaced in the UI — mirrors the CLI's wording so all
 *  surfaces make the same promise (no over-claiming). */
export const STRUCTURED_GUARANTEE_CAVEAT =
  "Only Gemini guarantees json_schema; other providers are best-effort (json_object / prompt coercion), validated locally but not guaranteed.";

export interface SchemaParseOk {
  schema: JsonSchema;
}
export interface SchemaParseErr {
  error: string;
}
export type SchemaParseResult = SchemaParseOk | SchemaParseErr;

/**
 * Validate that the pasted text is a well-formed JSON Schema: real JSON AND a
 * plain object (a JSON Schema — an array or a scalar is rejected, matching the
 * CLI's `loadJsonSchema`). Returns the parsed schema, or a clear, user-facing
 * `error` string. NEVER throws.
 */
export function parseSchemaInput(input: string): SchemaParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { error: "Paste a JSON Schema, or switch to “JSON object”." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    return { error: `Not valid JSON: ${detail}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      error: "A JSON Schema must be a JSON object (not an array or a scalar).",
    };
  }
  return { schema: parsed as JsonSchema };
}

export interface BuildResult {
  /** The request to send. Absent when `mode === "off"` OR the schema is broken. */
  responseFormat?: ResponseFormat;
  /** A clear, inline error when a `json_schema` request can't be built (so the
   *  caller blocks the send and shows it — never sends a broken schema). */
  error?: string;
}

/**
 * Translate the web control's state INTO a model `ResponseFormat`:
 *   - `off`         → no responseFormat (plain text)
 *   - `json_object` → `{ type: "json_object" }`
 *   - `json_schema` → `{ type: "json_schema", schema, name, strict }`, but only
 *     when the pasted schema is well-formed; otherwise `{ error }` and NO request.
 *
 * Mirrors apps/cli `buildResponseFormat`. The flat field shape (top-level
 * `schema`/`name`/`strict`) matches packages/types `ResponseFormat`, which the
 * gateway/engine already consume.
 */
export function buildResponseFormat(opts: {
  mode: StructuredMode;
  schemaText?: string;
  name?: string;
  strict?: boolean;
}): BuildResult {
  if (opts.mode === "json_object") {
    return { responseFormat: { type: "json_object" } };
  }
  if (opts.mode === "json_schema") {
    const res = parseSchemaInput(opts.schemaText ?? "");
    if ("error" in res) return { error: res.error };
    return {
      responseFormat: {
        type: "json_schema",
        schema: res.schema,
        name: opts.name?.trim() || "response",
        strict: opts.strict ?? false,
      },
    };
  }
  return {};
}

/**
 * Parse a JSON-only assistant response for the render surface. Returns the parsed
 * value, or `undefined` when the text isn't a JSON object/array (so the caller
 * falls back to showing the raw text). NEVER throws.
 */
export function parseStructuredResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Pretty-print a parsed value (2-space indent). Falls back to String() for the
 *  pathological non-serializable case so it never throws. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A single, non-fatal schema-validation issue — structurally compatible with the
 *  engine/CLI `StructuredIssue` (path + message). */
export interface StructuredIssue {
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, t: string): boolean {
  const actual = typeOf(value);
  if (t === "number") return actual === "number" || actual === "integer";
  if (t === "integer") return actual === "integer";
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: StructuredIssue[],
): void {
  if (schema == null || typeof schema !== "object") return;

  // type — supports a single type or an array of allowed types.
  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => typeof t === "string" && matchesType(value, t));
    if (!ok) {
      issues.push({
        path,
        message: `expected type ${types.join(" | ")}, got ${typeOf(value)}`,
      });
      // A type mismatch makes deeper structural checks meaningless.
      return;
    }
  }

  // enum — deep-equality against the allowed set.
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => deepEqual(candidate, value))) {
      issues.push({ path, message: "value is not one of the allowed enum values" });
    }
  }

  // object — required keys, per-property schemas, additionalProperties:false.
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in obj)) {
          issues.push({ path: `${path}.${key}`, message: "required property is missing" });
        }
      }
    }
    const props = schema.properties;
    if (props && typeof props === "object") {
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) validateNode(obj[key], sub, `${path}.${key}`, issues);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) {
            issues.push({ path: `${path}.${key}`, message: "unexpected additional property" });
          }
        }
      }
    }
  }

  // array — validate each element against a single `items` schema.
  if (
    typeOf(value) === "array" &&
    schema.items &&
    typeof schema.items === "object" &&
    !Array.isArray(schema.items)
  ) {
    (value as unknown[]).forEach((el, i) =>
      validateNode(el, schema.items as JsonSchema, `${path}[${i}]`, issues),
    );
  }
}

/**
 * Locally validate a parsed value against a JSON Schema. A deliberately LIGHT,
 * NON-THROWING validator covering what LLM JSON answers actually use (type,
 * required, enum, nested properties, array items, additionalProperties:false) —
 * NOT a full draft validator. Returns the list of issues (empty = conforms). This
 * is best-effort honesty for the non-blocking "doesn't match schema" notice, not
 * a guarantee.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
): StructuredIssue[] {
  const issues: StructuredIssue[] = [];
  try {
    validateNode(value, schema, "$", issues);
  } catch {
    // A pathological schema must never crash the render — just report nothing.
    return [];
  }
  return issues;
}
