"use client";

import {
  STRUCTURED_GUARANTEE_CAVEAT,
  type StructuredMode,
} from "@/lib/structured-output";

const MODES: { value: StructuredMode; label: string; title: string }[] = [
  { value: "off", label: "Off", title: "Plain text — no structured-output request" },
  {
    value: "json_object",
    label: "JSON object",
    title: "Ask the provider for syntactically-valid JSON (json_object)",
  },
  {
    value: "json_schema",
    label: "Schema",
    title: "Paste a JSON Schema and ask the provider to conform to it (json_schema)",
  },
];

const EXAMPLE_SCHEMA = `{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["title"]
}`;

/**
 * The web structured-output editor (lives in the composer's "More" popover).
 * Lets the user choose Off / JSON object / Schema; in Schema mode a textarea
 * accepts a pasted JSON Schema. Validation + the actual `response_format` build
 * happen in the parent (lib/structured-output `buildResponseFormat`), which
 * surfaces `error` here so a broken schema is shown inline and never sent.
 *
 * Mirrors the CLI's honesty: only Gemini guarantees `json_schema`; others are
 * best-effort. That caveat is shown whenever a structured mode is active.
 */
export function StructuredOutputControl({
  mode,
  schemaText,
  error,
  onModeChange,
  onSchemaTextChange,
}: {
  mode: StructuredMode;
  schemaText: string;
  /** Inline schema-parse error from the parent (null when the schema is OK). */
  error: string | null;
  onModeChange: (mode: StructuredMode) => void;
  onSchemaTextChange: (text: string) => void;
}) {
  return (
    <div className="structured-output-control">
      <div className="composer-picker-section">Structured output</div>
      <div
        role="radiogroup"
        aria-label="Structured output mode"
        style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 4px 6px" }}
      >
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            className={`chat-tool-toggle${mode === m.value ? " active" : ""}`}
            onClick={() => onModeChange(m.value)}
            title={m.title}
          >
            {m.value === "off" ? null : <span aria-hidden>{"{}"}</span>} {m.label}
          </button>
        ))}
      </div>

      {mode === "json_schema" ? (
        <div style={{ padding: "0 4px 4px" }}>
          <textarea
            className="structured-output-schema"
            value={schemaText}
            onChange={(e) => onSchemaTextChange(e.target.value)}
            placeholder={EXAMPLE_SCHEMA}
            spellCheck={false}
            rows={7}
            aria-label="JSON Schema"
            aria-invalid={Boolean(error)}
            style={{
              width: "100%",
              resize: "vertical",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 12,
              lineHeight: 1.5,
              padding: "6px 8px",
              borderRadius: 8,
              border: `1px solid ${error ? "#b91c1c" : "var(--c-border, #232a36)"}`,
              background: "rgba(148,163,184,0.06)",
              color: "var(--color-text, #e2e8f0)",
            }}
          />
          {error ? (
            <div
              className="structured-output-error"
              role="alert"
              style={{ marginTop: 4, fontSize: 12, color: "#f87171" }}
            >
              {error} — fix it or the request won’t be sent.
            </div>
          ) : null}
        </div>
      ) : null}

      {mode !== "off" ? (
        <div
          className="structured-output-caveat"
          style={{
            padding: "0 4px 4px",
            fontSize: 11.5,
            lineHeight: 1.45,
            color: "var(--color-text-sub)",
          }}
        >
          {STRUCTURED_GUARANTEE_CAVEAT}
        </div>
      ) : null}
    </div>
  );
}
