/**
 * Language detection by file extension (v1, no content sniffing).
 */

import { extname } from "node:path";

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".html": "html",
  ".css": "css",
  ".scss": "css",
  ".vue": "vue",
  ".svelte": "svelte",
};

/** Extensions we are willing to index. Everything else is skipped. */
export const SOURCE_EXTENSIONS = new Set(Object.keys(EXT_TO_LANG));

export function detectLang(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? "text";
}

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}
