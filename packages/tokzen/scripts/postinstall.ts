import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const grammarsDir = join(__dirname, "../grammars");
if (!existsSync(grammarsDir)) mkdirSync(grammarsDir, { recursive: true });

const coreSrc = join(__dirname, "../../node_modules/web-tree-sitter/tree-sitter.wasm");
if (existsSync(coreSrc)) {
  copyFileSync(coreSrc, join(grammarsDir, "tree-sitter.wasm"));
  console.log("✓ tree-sitter.wasm");
} else {
  console.warn("⚠ web-tree-sitter WASM not found");
}

const grammarPkgs = [
  ["tree-sitter-javascript", "tree-sitter-javascript.wasm"],
  ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  ["tree-sitter-python", "tree-sitter-python.wasm"],
] as const;

for (const [pkg, file] of grammarPkgs) {
  const candidates = [
    join(__dirname, `../../node_modules/${pkg}/${file}`),
    join(__dirname, `../../node_modules/${pkg}/tree-sitter-${pkg.replace("tree-sitter-", "")}.wasm`),
  ];
  const src = candidates.find(existsSync);
  if (src) {
    copyFileSync(src, join(grammarsDir, file));
    console.log(`✓ ${file}`);
  }
}
