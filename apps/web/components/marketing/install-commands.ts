export const REPO_INSTALL_COMMAND =
  "git clone https://github.com/zintus/zintus.git && cd zintus && bun install";

export const INSTALL_SNIPPETS = {
  repo: REPO_INSTALL_COMMAND,
  cli: "bun run dev:cli -- --help",
  gateway: "bun run dev:gateway",
  web: "bun run dev:web",
} as const;

export type InstallSnippetKey = keyof typeof INSTALL_SNIPPETS;
