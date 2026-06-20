import * as p from "@clack/prompts";
import chalk from "chalk";
import { validateAndStoreKey } from "../commands/keys.js";
import { listKeys } from "@zintus/keychain";
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";
import { PROVIDER_META } from "../lib/router.js";

const CLOUD_PROVIDERS = PROVIDER_IDS.filter(
  (id): id is Exclude<ProviderId, "ollama" | "lmstudio"> =>
    id !== "ollama" && id !== "lmstudio",
);

/** Where to get a free-tier API key for each provider. */
const SIGNUP_URLS: Partial<Record<ProviderId, string>> = {
  groq: "https://console.groq.com/keys",
  cerebras: "https://cloud.cerebras.ai",
  gemini: "https://aistudio.google.com/apikey",
  fireworks: "https://fireworks.ai/account/api-keys",
  xai: "https://console.x.ai",
  huggingface: "https://huggingface.co/settings/tokens",
  openrouter: "https://openrouter.ai/keys",
  cohere: "https://dashboard.cohere.com/api-keys",
  mistral: "https://console.mistral.ai/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
};

/** Max attempts per provider before we move on instead of looping forever. */
const MAX_ATTEMPTS = 3;

export async function runSetup(): Promise<void> {
  p.intro(chalk.inverse(" zintus setup "));

  const existing = await listKeys();
  const configured = new Set(existing.map((k) => k.provider));
  if (existing.length > 0) {
    p.log.info(
      `${existing.length} key(s) already stored: ${existing
        .map((k) => k.provider)
        .join(", ")}. Add more or press Ctrl+C to exit.`,
    );
  } else {
    p.log.message(
      chalk.dim(
        "Add at least one free provider key. Each option below links to where you get one.",
      ),
    );
  }

  const selected = await p.multiselect({
    message: "Which providers do you want to configure?",
    options: CLOUD_PROVIDERS.map((id) => ({
      value: id,
      label: configured.has(id)
        ? `${PROVIDER_META[id].name} ${chalk.dim("(already set — re-enter to replace)")}`
        : PROVIDER_META[id].name,
      hint: SIGNUP_URLS[id],
    })),
    required: false,
  });

  if (p.isCancel(selected)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const providers = (selected as ProviderId[]) ?? [];
  if (providers.length === 0) {
    p.outro(chalk.yellow("No providers selected."));
    return;
  }

  let stored = 0;
  for (const provider of providers) {
    const url = SIGNUP_URLS[provider];
    if (url) {
      p.log.step(`${PROVIDER_META[provider].name} — get a key: ${chalk.underline(url)}`);
    }

    let done = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
      const key = await p.password({
        message: `${PROVIDER_META[provider].name} API key`,
        validate: (value) => (value.trim() ? undefined : "Key is required"),
      });

      if (p.isCancel(key)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const spinner = p.spinner();
      spinner.start("Validating key");
      const result = await validateAndStoreKey(provider, String(key).trim());
      if (result.ok) {
        spinner.stop(chalk.green(`✓ ${PROVIDER_META[provider].name} key stored`));
        stored++;
        done = true;
      } else {
        spinner.stop(
          chalk.red(
            `✗ ${result.error ?? "Validation failed"}${
              attempt < MAX_ATTEMPTS ? " — try again" : " — skipping"
            }`,
          ),
        );
      }
    }
  }

  if (stored > 0) {
    p.outro(
      chalk.green(
        `Stored ${stored} key(s). Run \`zintus status\` to verify providers.`,
      ),
    );
  } else {
    p.outro(chalk.yellow("No keys stored."));
  }
}
