import type {
  ChatMessage,
  ToolCallContentBlock,
  ToolDefinition,
} from "@zintus/types";

/** Cap on tool execute→feed-back rounds — matches the web chat's MAX_TOOL_ROUNDS.
 *  Bounds the loop so a model that keeps calling tools can't run away. */
export const MAX_TOOL_ROUNDS = 5;

/**
 * Built-in, side-effect-free tools the CLI can ACTUALLY execute, so `--tools`
 * is a real round-trip (model calls a tool -> we run it -> feed the result back
 * -> model answers) rather than just printing the call. This mirrors the web
 * chat's `apps/web/lib/web-tools.ts` so the loop behaves identically across
 * platforms (the consistency rule).
 *
 * SAFETY: every executor is pure and self-contained — no `eval`/`Function`, no
 * network, no filesystem. Arbitrary user-authored tool code is deliberately NOT
 * executed here: an unknown tool name is surfaced as an honest error result the
 * model can recover from, never silently run.
 */
export interface BuiltinTool {
  definition: ToolDefinition;
  /** Runs the tool and returns a JSON string result. Never throws. */
  execute: (args: Record<string, unknown>) => string;
}

/**
 * A tiny, eval-free arithmetic evaluator (recursive descent). Supports `+ - * / %`,
 * parentheses, unary +/-, and decimals. Throws on any malformed input. No `eval`/
 * `Function` — we never hand model-authored text to a code evaluator.
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

const calculator: BuiltinTool = {
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

const currentDatetime: BuiltinTool = {
  definition: {
    name: "current_datetime",
    description:
      "Get the current date and time from the local clock. Use this when asked about the current date, time, or day.",
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

const randomNumber: BuiltinTool = {
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

export const BUILTIN_CLI_TOOLS: BuiltinTool[] = [
  calculator,
  currentDatetime,
  randomNumber,
];

/** The definitions sent to the model when `--tools` is on (no file given). */
export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = BUILTIN_CLI_TOOLS.map(
  (t) => t.definition,
);

const TOOLS_BY_NAME = new Map(
  BUILTIN_CLI_TOOLS.map((t) => [t.definition.name, t]),
);

export interface ToolExecutionResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/** Execute one model tool call against the built-in tools. Never throws — an
 *  unknown tool or a failure is returned as a structured `isError` result so the
 *  model can recover on the next turn (the error is surfaced, never hidden). */
export function executeBuiltinToolCall(call: {
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

/** A routed+streamed turn — the minimal shape the loop needs from the engine. */
export interface ToolLoopTurn {
  stream: AsyncIterable<string>;
  /** Live array, complete only after `stream` is fully drained. */
  toolCalls?: ToolCallContentBlock[];
}

export interface ToolLoopHandlers<R extends ToolLoopTurn> {
  /** Route + stream a single turn for the given conversation. */
  route: (messages: ChatMessage[], round: number) => Promise<R>;
  /** Round cap (defaults to MAX_TOOL_ROUNDS). */
  maxRounds?: number;
  /** After the turn is routed, before the stream is drained. */
  onRouted?: (result: R, round: number) => void | Promise<void>;
  /** For each streamed text chunk. */
  onChunk?: (chunk: string) => void;
  /** End of a turn's text stream (newline boundary for the renderer). */
  onTurnEnd?: () => void;
  /** The tool calls the model emitted this round (always non-empty here). */
  onToolCalls?: (calls: ToolCallContentBlock[]) => void;
  /** Each executed tool result, paired with its originating call. */
  onToolResult?: (result: ToolExecutionResult, call: ToolCallContentBlock) => void;
  /** The round cap was hit while the model was still calling tools. */
  onStopped?: (maxRounds: number) => void;
}

/**
 * The bounded execute→feed-back loop, shared by the CLI and directly testable
 * with a mocked `route`. Each round: route the conversation (with tools) → drain
 * the text stream → if the model emitted tool calls, execute the BUILT-IN ones
 * locally → append the assistant tool_call turn and our tool_result turn → loop.
 * Stops on the first round with no tool calls (final answer) or at `maxRounds`
 * (bounded — a runaway model is surfaced, not looped forever).
 */
export async function runBuiltinToolLoop<R extends ToolLoopTurn>(
  messages: ChatMessage[],
  handlers: ToolLoopHandlers<R>,
): Promise<{ finalResult: R; rounds: number }> {
  const maxRounds = handlers.maxRounds ?? MAX_TOOL_ROUNDS;
  const convo: ChatMessage[] = [...messages];
  let finalResult!: R;

  for (let round = 0; round <= maxRounds; round += 1) {
    const result = await handlers.route(convo, round);
    finalResult = result;
    await handlers.onRouted?.(result, round);

    let streamedText = "";
    for await (const chunk of result.stream) {
      streamedText += chunk;
      handlers.onChunk?.(chunk);
    }
    handlers.onTurnEnd?.();

    const calls = result.toolCalls ?? [];
    if (calls.length === 0) return { finalResult: result, rounds: round + 1 };

    handlers.onToolCalls?.(calls);

    // Bounded: if the model is STILL calling tools at the cap, stop.
    if (round === maxRounds) {
      handlers.onStopped?.(maxRounds);
      return { finalResult: result, rounds: round + 1 };
    }

    const results = calls.map((c) =>
      executeBuiltinToolCall({ id: c.id, name: c.name, arguments: c.arguments }),
    );
    for (const r of results) {
      const call = calls.find((c) => c.id === r.toolCallId);
      if (call) handlers.onToolResult?.(r, call);
    }

    convo.push({
      role: "assistant",
      content: [
        ...(streamedText.trim()
          ? [{ type: "text" as const, text: streamedText }]
          : []),
        ...calls,
      ],
    });
    convo.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        toolCallId: r.toolCallId,
        content: r.content,
        isError: r.isError,
      })),
    });
  }

  // Unreachable (the round === maxRounds branch returns), but keeps TS total.
  return { finalResult, rounds: maxRounds + 1 };
}
