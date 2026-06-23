// MIT License — see LICENSE file
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countTokensFast } from "../tokenizer/count.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";

export interface CodeCompressOptions {
  minBodyLines?: number;
  keepErrorHandlers?: boolean;
  language?: "ts" | "js" | "py";
}

// Lazy parser cache — one parser instance (or null sentinel) per language.
const parserCache = new Map<string, TreeSitterParser | null>();

const GRAMMAR_FILE: Record<"ts" | "js" | "py", string> = {
  ts: "tree-sitter-typescript.wasm",
  js: "tree-sitter-javascript.wasm",
  py: "tree-sitter-python.wasm",
};

const LANG_LABEL: Record<"ts" | "js" | "py", string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
};

function detectLanguage(content: string): "ts" | "js" | "py" {
  if (/^\s*(def |class |import |from .* import|@)/m.test(content) && !/[{}]/.test(content.slice(0, 200))) {
    return "py";
  }
  if (/:\s*(string|number|boolean|void|Promise|Record|Array|unknown|any)\b/.test(content)) {
    return "ts";
  }
  return "js";
}

function grammarsDir(): string {
  return join(fileURLToPath(import.meta.url), "..", "..", "..", "grammars");
}

// web-tree-sitter 0.25.x ships NAMED exports (Parser, Language) with no default.
// Parser.init() needs no locateFile under Node/Bun — it resolves tree-sitter.wasm
// next to its own module. Language is a top-level export (NOT Parser.Language).
type WebTreeSitterModule = {
  Parser: {
    init(): Promise<void>;
    new (): TreeSitterParser;
  };
  Language: {
    load(path: string): Promise<unknown>;
  };
};

async function getParser(lang: "ts" | "js" | "py"): Promise<TreeSitterParser | null> {
  if (parserCache.has(lang)) return parserCache.get(lang) ?? null;

  const wasmName = GRAMMAR_FILE[lang];
  const wasmPath = join(grammarsDir(), wasmName);

  if (!existsSync(wasmPath)) {
    console.warn(`[tokzen] AST fallback: text mode (grammar not found: ${wasmName})`);
    parserCache.set(lang, null);
    return null;
  }

  try {
    const mod = (await import("web-tree-sitter")) as unknown as WebTreeSitterModule;
    const { Parser, Language } = mod;
    await Parser.init();
    const language = await Language.load(wasmPath);
    const parser = new Parser();
    (parser as unknown as { setLanguage(l: unknown): void }).setLanguage(language);
    parserCache.set(lang, parser);
    console.error(`[tokzen] AST mode: ${LANG_LABEL[lang]}`);
    return parser;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[tokzen] AST fallback: text mode (load failed for ${wasmName}: ${reason})`);
    parserCache.set(lang, null);
    return null;
  }
}

/** Text-based fallback when tree-sitter WASM is unavailable. */
function compressCodeTextBased(
  content: string,
  opts: CodeCompressOptions,
): string {
  const minBodyLines = opts.minBodyLines ?? 5;
  const lines = content.split("\n");
  const result: string[] = [];
  let braceDepth = 0;
  let inBody = false;
  let bodyLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Always keep imports/exports/declarations
    if (
      /^(import|export|from|const\s+\w+\s*=|type\s+\w|interface\s+\w|enum\s+\w|@\w)/.test(trimmed)
    ) {
      result.push(line);
      continue;
    }

    // Function/class/method signatures
    const isSig =
      /^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed) ||
      /^(export\s+)?(abstract\s+)?class\s+\w+/.test(trimmed) ||
      /^(public|private|protected|static|async|override|\w+)\s*[\w<[(].*\)\s*[:{]/.test(trimmed);

    if (isSig) {
      result.push(line);
      inBody = false;
      braceDepth = 0;
      bodyLines = 0;
    }

    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;

    if (opens > 0 && !inBody && braceDepth > 0) {
      inBody = true;
      bodyLines = 0;
    }

    if (inBody) {
      bodyLines++;
      if (braceDepth === 0) {
        // End of body
        if (bodyLines > minBodyLines) {
          result.push(`  { /* ${bodyLines} lines omitted */ }`);
        }
        inBody = false;
      }
    } else if (!isSig) {
      result.push(line);
    }
  }

  return result.join("\n");
}

type TreeSitterNode = {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: (TreeSitterNode | null)[];
  parent: TreeSitterNode | null;
  startIndex: number;
  endIndex: number;
};

type TreeSitterTree = {
  rootNode: TreeSitterNode;
};

type TreeSitterParser = {
  parse(content: string): TreeSitterTree | null;
};

// A "body" node whose parent is one of these gets its interior elided. Gating on
// the parent type (rather than a raw depth heuristic) avoids stripping Python
// class bodies — `class_definition` is NOT here, so method signatures survive.
const BODY_TYPES = new Set(["statement_block", "block"]);
const FUNCTION_PARENT_TYPES = new Set([
  // JavaScript / TypeScript
  "function_declaration",
  "function_expression",
  "function",
  "arrow_function",
  "method_definition",
  "generator_function",
  "generator_function_declaration",
  // Python
  "function_definition",
]);
const ERROR_HANDLER_TYPES = new Set([
  "try_statement",
  "catch_clause",
  "finally_clause",
  "except_clause",
]);

function containsErrorHandler(node: TreeSitterNode): boolean {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (ERROR_HANDLER_TYPES.has(child.type)) return true;
    if (containsErrorHandler(child)) return true;
  }
  return false;
}

function compressWithAST(
  content: string,
  tree: TreeSitterTree,
  lang: "ts" | "js" | "py",
  opts: CodeCompressOptions,
): string {
  const minBodyLines = opts.minBodyLines ?? 5;
  const keepErrorHandlers = opts.keepErrorHandlers !== false;

  // Character-index edits — splicing by index preserves the signature and the
  // braces around a body regardless of formatting (the line-based approach
  // could clobber a signature when `{` shared the signature's line).
  const edits: Array<{ start: number; end: number; replacement: string }> = [];

  function makeReplacement(node: TreeSitterNode, bodyLines: number): string {
    if (lang === "py") {
      // Python `block` excludes the `def …:` line, so replace it with a comment.
      const indent = " ".repeat(node.startPosition.column);
      return `${indent}# ... ${bodyLines} lines omitted ...`;
    }
    // Brace languages: the node spans `{ … }`; keep the braces, elide the inside.
    return `{ /* ${bodyLines} lines omitted */ }`;
  }

  function walk(node: TreeSitterNode): void {
    const isElidableBody =
      BODY_TYPES.has(node.type) &&
      node.parent !== null &&
      FUNCTION_PARENT_TYPES.has(node.parent.type);

    if (isElidableBody) {
      const bodyLines = node.endPosition.row - node.startPosition.row + 1;
      const keep = keepErrorHandlers && containsErrorHandler(node);
      if (bodyLines > minBodyLines && !keep) {
        edits.push({
          start: node.startIndex,
          end: node.endIndex,
          replacement: makeReplacement(node, bodyLines),
        });
        return; // don't descend into an elided body
      }
    }

    for (const child of node.namedChildren) {
      if (child) walk(child);
    }
  }

  walk(tree.rootNode);

  // Apply edits right-to-left so earlier indices stay valid. walk() never
  // descends into an elided body, so ranges cannot overlap.
  edits.sort((a, b) => b.start - a.start);
  let out = content;
  for (const { start, end, replacement } of edits) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

/**
 * Compresses code by eliding function bodies while keeping signatures, imports,
 * classes, and (by default) error handlers, via web-tree-sitter AST analysis.
 * Falls back to text heuristics when the grammar WASM is unavailable.
 *
 * This is lossy-but-honest: the marker states bodies were elided. It does NOT
 * promise a `retrieve()` round-trip, because the gateway has no tool-calling
 * path to satisfy one (see apps/gateway/src/handler.ts).
 */
export async function compressCode(
  content: string,
  ctx?: Partial<CompressContext>,
  opts: CodeCompressOptions = {},
): Promise<CompressResult> {
  void ctx;
  const originalTokens = countTokensFast(content);
  const noop = (): CompressResult => ({
    content,
    originalTokens,
    compressedTokens: originalTokens,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  });

  try {
    const lang = opts.language ?? detectLanguage(content);
    const parser = await getParser(lang);

    let compressed: string;
    let usedTransform: string;

    if (parser) {
      const tree = parser.parse(content);
      if (!tree) return noop(); // parse() returns null with no language / on abort
      compressed = compressWithAST(content, tree, lang, opts);
      usedTransform = "ast-signature";
    } else {
      compressed = compressCodeTextBased(content, opts);
      usedTransform = "text-signature";
    }

    const compressedTokens = countTokensFast(compressed);

    // Only add a marker if we actually reduced content.
    if (compressedTokens >= originalTokens) {
      return noop();
    }

    const comment = lang === "py" ? "#" : "//";
    const originalLines = content.split("\n").length;
    const compressedLineCount = compressed.split("\n").length;
    const marker = `\n${comment} [tokzen: ${originalLines}→${compressedLineCount} lines, function bodies elided]`;
    const result = compressed + marker;
    const resultTokens = countTokensFast(result);

    return {
      content: result,
      originalTokens,
      compressedTokens: resultTokens,
      ratio: resultTokens / originalTokens,
      transforms: [usedTransform],
      ccrHashes: [],
      cacheHit: false,
    };
  } catch {
    return noop();
  }
}
