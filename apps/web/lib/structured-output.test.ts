import { describe, expect, test } from "bun:test";
import type { JsonSchema } from "@zintus/types";
import {
  buildResponseFormat,
  parseSchemaInput,
  parseStructuredResponse,
  prettyJson,
  validateAgainstSchema,
  STRUCTURED_GUARANTEE_CAVEAT,
} from "./structured-output";

const PERSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
    role: { type: "string", enum: ["admin", "user"] },
  },
  required: ["name", "age"],
};

describe("buildResponseFormat", () => {
  test("off → no responseFormat (plain text, unchanged behavior)", () => {
    expect(buildResponseFormat({ mode: "off" })).toEqual({});
  });

  test("json_object → { type: 'json_object' }", () => {
    expect(buildResponseFormat({ mode: "json_object" })).toEqual({
      responseFormat: { type: "json_object" },
    });
  });

  test("schema mode SENDS response_format { type: 'json_schema', schema, name, strict }", () => {
    const result = buildResponseFormat({
      mode: "json_schema",
      schemaText: JSON.stringify(PERSON_SCHEMA),
    });
    expect(result.error).toBeUndefined();
    expect(result.responseFormat).toEqual({
      type: "json_schema",
      schema: PERSON_SCHEMA,
      name: "response",
      strict: false,
    });
  });

  test("schema mode honors a custom name + strict flag", () => {
    const result = buildResponseFormat({
      mode: "json_schema",
      schemaText: JSON.stringify(PERSON_SCHEMA),
      name: "person",
      strict: true,
    });
    expect(result.responseFormat).toMatchObject({
      type: "json_schema",
      name: "person",
      strict: true,
    });
  });

  test("MALFORMED schema is blocked with an error and is NOT sent", () => {
    const result = buildResponseFormat({
      mode: "json_schema",
      schemaText: "{ not valid json",
    });
    expect(result.responseFormat).toBeUndefined();
    expect(result.error).toContain("Not valid JSON");
  });

  test("a non-object schema (array) is rejected and NOT sent", () => {
    const result = buildResponseFormat({
      mode: "json_schema",
      schemaText: "[1,2,3]",
    });
    expect(result.responseFormat).toBeUndefined();
    expect(result.error).toContain("must be a JSON object");
  });

  test("an empty schema in schema mode is an error (nothing sent)", () => {
    const result = buildResponseFormat({ mode: "json_schema", schemaText: "   " });
    expect(result.responseFormat).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});

describe("parseSchemaInput", () => {
  test("accepts a well-formed object schema", () => {
    expect(parseSchemaInput(JSON.stringify(PERSON_SCHEMA))).toEqual({
      schema: PERSON_SCHEMA,
    });
  });

  test("rejects a scalar", () => {
    const res = parseSchemaInput("42");
    expect("error" in res).toBe(true);
  });
});

describe("parseStructuredResponse + prettyJson (render surface)", () => {
  test("a structured response renders as formatted (pretty-printed) JSON", () => {
    const raw = '{"name":"Ada","age":36}';
    const parsed = parseStructuredResponse(raw);
    expect(parsed).toEqual({ name: "Ada", age: 36 });
    // Pretty-printed with 2-space indent — the readable render surface.
    expect(prettyJson(parsed)).toBe('{\n  "name": "Ada",\n  "age": 36\n}');
  });

  test("non-JSON prose returns undefined (caller falls back to raw text)", () => {
    expect(parseStructuredResponse("just a sentence")).toBeUndefined();
    expect(parseStructuredResponse("")).toBeUndefined();
  });

  test("malformed JSON-looking text returns undefined (never throws)", () => {
    expect(parseStructuredResponse("{oops")).toBeUndefined();
  });
});

describe("validateAgainstSchema (non-blocking schema check)", () => {
  test("a conforming response has no issues", () => {
    const value = { name: "Ada", age: 36, role: "admin" };
    expect(validateAgainstSchema(value, PERSON_SCHEMA)).toEqual([]);
  });

  test("a response that VIOLATES the schema yields issues (drives the notice)", () => {
    // age is a string (wrong type), role not in enum, name missing.
    const value = { age: "old", role: "superuser" };
    const issues = validateAgainstSchema(value, PERSON_SCHEMA);
    expect(issues.length).toBeGreaterThan(0);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("$.name"); // required missing
    expect(paths).toContain("$.age"); // type mismatch
    expect(paths).toContain("$.role"); // enum violation
  });

  test("validates nested array items", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    };
    const issues = validateAgainstSchema({ tags: ["ok", 7] }, schema);
    expect(issues.some((i) => i.path === "$.tags[1]")).toBe(true);
  });

  test("flags unexpected keys when additionalProperties is false", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    const issues = validateAgainstSchema({ a: "x", b: "y" }, schema);
    expect(issues.some((i) => i.path === "$.b")).toBe(true);
  });

  test("a pathological schema never throws (returns no issues)", () => {
    // null schema would throw inside a naive validator.
    expect(() =>
      validateAgainstSchema({ a: 1 }, null as never),
    ).not.toThrow();
  });
});

describe("honesty caveat", () => {
  test("names Gemini as the only json_schema guarantee (mirrors the CLI)", () => {
    expect(STRUCTURED_GUARANTEE_CAVEAT).toContain("Gemini");
    expect(STRUCTURED_GUARANTEE_CAVEAT.toLowerCase()).toContain("best-effort");
  });
});
