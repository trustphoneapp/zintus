import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ml/llmlingua.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: [
    "bun:sqlite",
    "web-tree-sitter",
    "@atjsh/llmlingua-2",
    "@huggingface/transformers",
    "@toon-format/toon",
    "drain3-js",
  ],
});
