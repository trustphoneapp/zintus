// Single honest source of truth for how the CLI is installed today.
//
// The Zintus CLI is NOT yet published to a public package registry, so
// `npm install -g zintus` / `bun install -g zintus` 404. Until it is published,
// the only working install path is build-from-source with Bun (the CLI uses
// bun:sqlite, so it runs on Bun, not Node). Keep CLI_PUBLISHED=false until the
// `zintus` package is actually live — then the registry commands become honest.
export const CLI_PUBLISHED = false;

// Available once CLI_PUBLISHED flips to true. Do not advertise as working today.
export const NPM_INSTALL_COMMAND = "npm install -g zintus";

// The real, working install path today.
export const BUILD_FROM_SOURCE_COMMAND =
  "git clone https://github.com/trustphoneapp/zintus && cd zintus && bun install && bun run --filter zintus build";

// Honest first-run steps after a from-source build.
export const INSTALL_STEPS = [
  "bun install",
  "bun run --filter zintus build",
  "zintus chat",
] as const;
