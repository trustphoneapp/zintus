// MIT License — see LICENSE file
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countTokensFast } from "../tokenizer/count.js";
import { getDefaultCCRStore } from "../ccr/store.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";

export interface CodeCompressOptions {
  minBodyLines?: number;
  keepErrorHandlers?: boolean;
  language?: "ts" | "js" | "py";
}

// Lazy parser cache — one parser instance per language
const parserCache = new Map<string, unknown>();

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

async function getParser(lang: "ts" | "js" | "py"): Promise<TreeSitterParser | null> {
  if (parserCache.has(lang)) return (parserCache.get(lang) as TreeSitterParser | undefined) ?? null;

  try {
    // web-tree-sitter 0.25.x: default export is the Parser class itself
    const mod = (await import("web-tree-sitter") as unknown) as {
      default: {
        init(): Promise<void>;
        Language: { load(path: string): Promise<unknown> };
        new(): TreeSitterParser;
      };
    };
    const Parser = mod.default;
    await Parser.init();
    const wasmName =
      lang === "py"
        ? "tree-sitter-python.wasm"
        : lang === "ts"
        ? "tree-sitter-typescript.wasm"
        : "tree-sitter-javascript.wasm";
    const language = await Parser.Language.load(join(grammarsDir(), wasmName));
    const parser = new Parser();
    (parser as unknown as { setLanguage(l: unknown): void }).setLanguage(language);
    parserCache.set(lang, parser);
    return parser;
  } catch {
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
          result.push(`  { /* ${bodyLines} lines compressed */ }`);
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
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
  parent: TreeSitterNode | null;
  startIndex: number;
  endIndex: number;
};

type TreeSitterTree = {
  rootNode: TreeSitterNode;
};

type TreeSitterParser = {
  parse(content: string): TreeSitterTree;
};

const BODY_TYPES = new Set([
  "statement_block",
  "block",
  "function_body",
]);

function isErrorHandler(node: TreeSitterNode): boolean {
  return (
    node.type === "try_statement" ||
    node.type === "catch_clause" ||
    node.type === "finally_clause" ||
    node.type === "except_clause"
  );
}

function compressWithAST(
  content: string,
  tree: TreeSitterTree,
  opts: CodeCompressOptions,
): string {
  const minBodyLines = opts.minBodyLines ?? 5;
  const keepErrorHandlers = opts.keepErrorHandlers !== false;
  const lines = content.split("\n");

  const suppressedRanges: Array<{ start: number; end: number; replacement: string }> = [];

  function walk(node: TreeSitterNode, depth: number): void {
    if (isErrorHandler(node) && keepErrorHandlers) {
      // Keep entire error handler block
      return;
    }

    if (BODY_TYPES.has(node.type) && depth > 1) {
      const bodyLines =
        node.endPosition.row - node.startPosition.row + 1;
      if (bodyLines > minBodyLines) {
        suppressedRanges.push({
          start: node.startPosition.row,
          end: node.endPosition.row,
          replacement: `{ /* ${bodyLines} lines compressed */ }`,
        });
        return;
      }
    }

    for (const child of node.namedChildren) {
      walk(child, depth + 1);
    }
  }

  walk(tree.rootNode, 0);

  // Apply suppressions from bottom to top to preserve line numbers
  suppressedRanges.sort((a, b) => b.start - a.start);
  const resultLines = [...lines];
  for (const { start, end, replacement } of suppressedRanges) {
    const indent = (resultLines[start] ?? "").match(/^(\s*)/)?.[1] ?? "";
    resultLines.splice(start, end - start + 1, `${indent}${replacement}`);
  }

  return resultLines.join("\n");
}

/**
 * Extracts signatures and preserves structure via AST (web-tree-sitter).
 * Falls back to text-based heuristics if tree-sitter is unavailable.
 */
export async function compressCode(
  content: string,
  ctx?: Partial<CompressContext>,
  opts: CodeCompressOptions = {},
): Promise<CompressResult> {
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
    const parser = await getParser(lang) as TreeSitterParser | null;

    let compressed: string;
    let usedTransform: string;

    if (parser) {
      const tree = parser.parse(content) as TreeSitterTree;
      compressed = compressWithAST(content, tree, opts);
      usedTransform = "ast-signature";
    } else {
      compressed = compressCodeTextBased(content, opts);
      usedTransform = "text-signature";
    }

    const compressedTokens = countTokensFast(compressed);

    // Only store in CCR and add marker if we actually reduced content
    if (compressedTokens >= originalTokens) {
      return { content, originalTokens, compressedTokens: originalTokens, ratio: 1, transforms: [], ccrHashes: [], cacheHit: false };
    }

    const store = getDefaultCCRStore();
    const hash = store.store(content, "code", { sessionId: ctx?.sessionId });
    const originalLines = content.split("\n").length;
    const compressedLineCount = compressed.split("\n").length;

    const marker = `\n// [Code compressed: ${originalLines} lines → ${compressedLineCount} lines. retrieve(${hash}) for full]`;
    const result = compressed + marker;
    const resultTokens = countTokensFast(result);

    return {
      content: result,
      originalTokens,
      compressedTokens: resultTokens,
      ratio: resultTokens / originalTokens,
      transforms: [usedTransform],
      ccrHashes: [hash],
      cacheHit: false,
    };
  } catch {
    return noop();
  }
}
