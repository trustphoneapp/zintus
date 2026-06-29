"use client";

import { useMemo } from "react";
import type { JsonSchema } from "@zintus/types";
import { CodeBlock } from "./Markdown";
import {
  parseStructuredResponse,
  prettyJson,
  validateAgainstSchema,
  type StructuredIssue,
} from "@/lib/structured-output";

/**
 * Render surface for a structured (JSON) response. Reuses the Markdown
 * `CodeBlock` chrome (language label + copy + monospace `pre`) so a parsed JSON
 * answer is shown pretty-printed instead of as raw prose.
 *
 * HONESTY / never-crash:
 *   - Pass `value` (already parsed) OR `raw` (the model's text). When `raw` isn't
 *     parseable JSON we fall back to showing it verbatim — never throw, never
 *     hide the output.
 *   - When a `schema` is provided we validate LOCALLY and surface a NON-BLOCKING
 *     "doesn't match the schema" notice; the JSON itself is still rendered.
 */
export function JsonView({
  raw,
  value,
  schema,
  label = "JSON output",
}: {
  raw?: string;
  value?: unknown;
  schema?: JsonSchema;
  label?: string;
}) {
  const parsed = useMemo(
    () =>
      value !== undefined
        ? value
        : raw !== undefined
          ? parseStructuredResponse(raw)
          : undefined,
    [raw, value],
  );

  const issues = useMemo<StructuredIssue[]>(() => {
    if (parsed === undefined || !schema) return [];
    return validateAgainstSchema(parsed, schema);
  }, [parsed, schema]);

  // Not parseable JSON → show the raw text (best-effort providers can return prose
  // even when asked for JSON). Never crash, never blank.
  if (parsed === undefined) {
    return raw ? <CodeBlock lang="text" text={raw} label={label} /> : null;
  }

  return (
    <div className="json-view">
      <CodeBlock lang="json" text={prettyJson(parsed)} label={label} />
      {issues.length > 0 ? (
        <div
          className="json-schema-mismatch"
          role="status"
          style={{
            marginTop: 6,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #6b4f1d",
            borderLeft: "2px solid #f59e0b",
            background: "rgba(245,158,11,0.08)",
            color: "#fcd34d",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            ⚠ This response doesn’t match the schema (shown anyway):
          </div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {issues.slice(0, 8).map((issue, i) => (
              <li key={`${issue.path}-${i}`}>
                <code>{issue.path}</code>: {issue.message}
              </li>
            ))}
            {issues.length > 8 ? (
              <li>…and {issues.length - 8} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
