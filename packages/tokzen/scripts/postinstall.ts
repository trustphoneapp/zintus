import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Copies prebuilt Tree-sitter grammar WASM files into packages/tokzen/grammars
// so the code compressor's AST mode works without a build step.
//
// Grammars come from `tree-sitter-wasms` (built with tree-sitter-cli 0.20.x →
// ABI 14), which is compatible with web-tree-sitter 0.25.x. Do NOT pair these
// with web-tree-sitter 0.26+ — that combination fails with
// "Incompatible language version". See packages/tokzen/src/compressors/code.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const grammarsDir = join(__dirname, "../grammars");
if (!existsSync(grammarsDir)) mkdirSync(grammarsDir, { recursive: true });

/** Resolve a file from one of several candidate node_modules locations. */
function resolveFromNodeModules(relPath: string): string | undefined {
  const roots = [
    join(__dirname, "../node_modules"), // per-package (isolated install)
    join(__dirname, "../../node_modules"), // hoisted to monorepo root
    join(__dirname, "../../../node_modules"), // nested workspace layouts
  ];
  for (const root of roots) {
    const candidate = join(root, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// web-tree-sitter resolves tree-sitter.wasm next to its module under Node/Bun,
// so this copy is belt-and-suspenders only — the code never points locateFile
// at it. Keep it for environments with unusual module resolution.
const coreSrc = resolveFromNodeModules("web-tree-sitter/tree-sitter.wasm");
if (coreSrc) {
  copyFileSync(coreSrc, join(grammarsDir, "tree-sitter.wasm"));
  console.log("✓ tree-sitter.wasm (runtime)");
} else {
  console.warn("⚠ web-tree-sitter runtime WASM not found — AST mode may fall back to text");
}

const grammars = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
];

for (const file of grammars) {
  const src = resolveFromNodeModules(`tree-sitter-wasms/out/${file}`);
  if (src) {
    copyFileSync(src, join(grammarsDir, file));
    console.log(`✓ ${file}`);
  } else {
    console.warn(`⚠ ${file} not found — text fallback will be used for this language`);
  }
}
