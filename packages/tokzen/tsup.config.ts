import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ml/llmlingua.ts", "src/mcp/server.ts"],
  format: ["esm", "cjs"],
  dts: { resolve: true },
  tsconfig: "./tsconfig.build.json",
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
