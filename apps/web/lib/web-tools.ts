import type { ToolDefinition } from "@zintus/types";

/**
 * Built-in, browser-safe tools the web chat can actually execute, so tool calling
 * is a real round-trip (model calls a tool -> we run it -> feed the result back ->
 * model answers) rather than API-only plumbing.
 *
 * SAFETY: every executor is pure and self-contained — no `eval`/`Function` (the
 * nonce CSP forbids `unsafe-eval` in production), no network, no DOM, no storage.
 * Arbitrary user-authored tool code is deliberately NOT supported here.
 */
export interface WebTool {
  definition: ToolDefinition;
  /** Runs the tool and returns a JSON string result. Never throws. */
  execute: (args: Record<string, unknown>) => string;
}

/**
 * A tiny, eval-free arithmetic evaluator (recursive descent). Supports `+ - * / %`,
 * parentheses, unary +/-, and decimals. Throws on any malformed input. No `eval`/
 * `Function`, so it works under the strict production CSP.
 */
function evalArithmetic(input: string): number {
  const s = input;
  let i = 0;
  const skip = () => {
    while (i < s.length && s[i] === " ") i += 1;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    skip();
    while (i < s.length && (s[i] === "+" || s[i] === "-")) {
      const op = s[i++]!;
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
      skip();
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    skip();
    while (i < s.length && (s[i] === "*" || s[i] === "/" || s[i] === "%")) {
      const op = s[i++]!;
      const r = parseFactor();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
      skip();
    }
    return v;
  };
  const parseFactor = (): number => {
    skip();
    if (s[i] === "+") {
      i += 1;
      return parseFactor();
    }
    if (s[i] === "-") {
      i += 1;
      return -parseFactor();
    }
    if (s[i] === "(") {
      i += 1;
      const v = parseExpr();
      skip();
      if (s[i] !== ")") throw new Error("expected )");
      i += 1;
      return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i]!)) i += 1;
    if (i === start) throw new Error("expected a number");
    const n = Number(s.slice(start, i));
    if (!Number.isFinite(n)) throw new Error("invalid number");
    return n;
  };
  const result = parseExpr();
  skip();
  if (i !== s.length) throw new Error("unexpected token");
  return result;
}

const calculator: WebTool = {
  definition: {
    name: "calculator",
    description:
      "Evaluate a basic arithmetic expression with + - * / % and parentheses. Use this for any arithmetic instead of computing it yourself.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "An arithmetic expression, e.g. (2 + 3) * 4 / 5",
        },
      },
      required: ["expression"],
    },
  },
  execute: (args) => {
    const expr = String(args.expression ?? "").trim();
    if (!expr) return JSON.stringify({ error: "expression is required" });
    try {
      const value = evalArithmetic(expr);
      return JSON.stringify({ result: value });
    } catch {
      return JSON.stringify({
        error: "could not evaluate — use only numbers and + - * / % ( )",
      });
    }
  },
};

const currentDatetime: WebTool = {
  definition: {
    name: "current_datetime",
    description:
      "Get the current date and time from the user's local clock. Use this when asked about the current date, time, or day.",
    parameters: { type: "object", properties: {} },
  },
  execute: () => {
    const now = new Date();
    return JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  },
};

const randomNumber: WebTool = {
  definition: {
    name: "random_number",
    description:
      "Generate a uniformly random integer between min and max (inclusive).",
    parameters: {
      type: "object",
      properties: {
        min: { type: "number", description: "Lower bound (inclusive)" },
        max: { type: "number", description: "Upper bound (inclusive)" },
      },
      required: ["min", "max"],
    },
  },
  execute: (args) => {
    const min = Math.ceil(Number(args.min));
    const max = Math.floor(Number(args.max));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      return JSON.stringify({
        error: "min and max must be numbers with min <= max",
      });
    }
    return JSON.stringify({
      result: Math.floor(Math.random() * (max - min + 1)) + min,
    });
  },
};

export const BUILTIN_WEB_TOOLS: WebTool[] = [
  calculator,
  currentDatetime,
  randomNumber,
];

/** The definitions sent to the model when tools are enabled. */
export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = BUILTIN_WEB_TOOLS.map(
  (t) => t.definition,
);

const TOOLS_BY_NAME = new Map(
  BUILTIN_WEB_TOOLS.map((t) => [t.definition.name, t]),
);

export interface ToolExecutionResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/** Execute one model tool call against the built-in tools. Never throws — an
 *  unknown tool or a failure is returned as a structured `isError` result so the
 *  model can recover on the next turn. */
export function executeWebToolCall(call: {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}): ToolExecutionResult {
  const tool = TOOLS_BY_NAME.get(call.name);
  if (!tool) {
    return {
      toolCallId: call.id,
      content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
      isError: true,
    };
  }
  try {
    const content = tool.execute(call.arguments ?? {});
    let isError = false;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      isError = parsed != null && typeof parsed === "object" && "error" in parsed;
    } catch {
      isError = false;
    }
    return { toolCallId: call.id, content, isError };
  } catch (error) {
    return {
      toolCallId: call.id,
      content: JSON.stringify({
        error: error instanceof Error ? error.message : "tool failed",
      }),
      isError: true,
    };
  }
}
